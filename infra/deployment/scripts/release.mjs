#!/usr/bin/env node
/**
 * TEX-40 受控发布/回滚最小编排（平台无关，目标 Linux；Node >= 22）。
 *
 * 运行目标模型：
 *   - `releases/<sha>/`：不可变版本目录（只读历史）；
 *   - `<RELEASE_ROOT>/current`：指向当前运行版本目录的 **原子可切换运行目标**
 *     （符号链接/结点）。服务启动前必须先切换它，使 ExecStart 解析到候选 artifact；
 *     health 成功后才写 state.json；health 失败自动回切旧运行目标并尝试恢复服务。
 *   - `state.json`：bookkeeping（current/previous/updatedAt），仅作为审计视图。
 *
 * 设计原则：
 *   - 路径/标识符显式校验；禁止 eval；子进程只经 runShell(argv)+显式 env 调用；
 *   - 无 --apply 一律 dry-run 打印计划并退出 0（默认安全失败）；
 *   - 不臆造 systemd/主机/凭据：服务控制只允许固定动词，SERVICE_NAME 由运维显式提供；
 *     敏感运行值仅透传子进程，从不写审计/日志/产物；
 *   - 部署顺序：verify → lock → unpack → verify → stop(旧) → switch current(候选)
 *     → start → health → activate(state)；失败回切并保留旧版。
 *   - 回滚顺序：verify → journal-prefix → stop → switch current(目标) → start → health
 *     → activate(state)；失败回切旧运行目标。
 *
 * systemd 集成契约（供 TEX-41）：ExecStart 必须解析 `<RELEASE_ROOT>/current`
 * （例如 `ExecStart=/usr/bin/node /srv/texas-holdem/current/dist/main.js`，EnvironmentFile
 * 注入运行环境）；本编排**不修改 systemd 单元**，只原子切换 `current` 并用固定动词
 * start/stop/restart/status 控制服务。
 *
 * 用法：
 *   node release.mjs status
 *   node release.mjs deploy [--apply] [--health-timeout-ms 60000]
 *   node release.mjs rollback [--to <sha>] [--apply] [--health-timeout-ms 60000]
 *
 * 环境（按子命令）：
 *   RELEASE_ROOT      版本布局根目录（releases/<sha>/、current、state.json、audit/、lock）
 *   ARTIFACT_TARBALL  tar.gz（deploy）
 *   ARTIFACT_MANIFEST 对应 manifest.json（deploy）
 *   SERVICE_CONTROL   none|systemctl|docker（默认 none；真实主机由 TEX-41/用户定）
 *   SERVICE_NAME      systemctl/docker 时必填
 *   APP_ENV_FILE      可选：注入应用的环境文件（KEY=VALUE，# 注释；不写日志）
 *   HEALTH_URL        可选健康检查 URL；缺省 http://127.0.0.1:${HEALTH_PORT:-3001}/health
 */

import { dirname, join, resolve, basename } from "node:path";
import { readFile, writeFile, mkdir, rename, readdir, symlink, readlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeTreeDigest,
  ensureDir,
  removeTree,
  runShell,
  sanitizeForAudit,
  sha256OfFile,
} from "./lib/artifact-lib.mjs";

/** 恢复旧运行目标时使用的服务动词：restart 可覆盖“候选已在运行”的情况。 */
export const RECOVERY_SERVICE_VERB = "restart";

const slash = (p) => p.replace(/\\/g, "/");
const SHA = /^[0-9a-f]{40}$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SERVICE_VERBS = new Set(["start", "stop", "restart", "status"]);

function usage() {
  return [
    "usage: node release.mjs <status|deploy|rollback> [--apply] [--to <sha>] [--health-timeout-ms <ms>]",
    "  status    打印版本布局、current 运行目标与当前/上一版",
    "  deploy    校验+解包+停旧+切换 current 到候选+启动+健康+激活",
    "  rollback  回滚到 --to 或 state.previous（先验完整性 + journal 前缀兼容）",
  ].join("\n");
}

/* ---------------- 纯函数/可导出（单测可导入） ---------------- */

export function parseCliArgv(argv) {
  const out = { apply: false, to: null, healthTimeoutMs: 60000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--health-timeout-ms") out.healthTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (a.startsWith("--health-timeout-ms=")) out.healthTimeoutMs = Number.parseInt(a.slice(a.indexOf("=") + 1), 10);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  if (Number.isNaN(out.healthTimeoutMs) || out.healthTimeoutMs <= 0) {
    throw new Error("--health-timeout-ms 必须是正整数毫秒（拒绝 0，避免被静默替换为默认超时）");
  }
  if (out.to !== null && !SHA.test(out.to)) throw new Error(`--to 非法 SHA: ${out.to}`);
  return out;
}

export function wireCli(cfg, parsed) {
  cfg.healthTimeoutMs = parsed.healthTimeoutMs;
  return cfg;
}

export function parseConfig(env, action) {
  if (!env.RELEASE_ROOT || !String(env.RELEASE_ROOT).trim()) {
    throw new Error("缺少 RELEASE_ROOT（版本布局根目录）");
  }
  const releaseRoot = resolve(env.RELEASE_ROOT);
  const serviceControl = (env.SERVICE_CONTROL || "none").toLowerCase();
  if (!["none", "systemctl", "docker"].includes(serviceControl)) {
    throw new Error(`SERVICE_CONTROL 非法: ${serviceControl}（允许 none|systemctl|docker）`);
  }
  const serviceName = env.SERVICE_NAME || "";
  if (serviceControl !== "none" && !serviceName) throw new Error(`SERVICE_CONTROL=${serviceControl} 时需要 SERVICE_NAME`);
  const healthUrl = env.HEALTH_URL || `http://127.0.0.1:${env.HEALTH_PORT || 3001}/health`;
  const databaseSchema = env.DATABASE_SCHEMA || "game";
  if (!SCHEMA_NAME.test(databaseSchema)) throw new Error(`DATABASE_SCHEMA 非法: ${databaseSchema}`);
  return {
    releaseRoot,
    releasesDir: join(releaseRoot, "releases"),
    currentLink: join(releaseRoot, "current"),
    statePath: join(releaseRoot, "state.json"),
    auditDir: join(releaseRoot, "audit"),
    lockDir: join(releaseRoot, "lock"),
    serviceControl,
    serviceName,
    appEnvFile: env.APP_ENV_FILE ? resolve(env.APP_ENV_FILE) : null,
    healthUrl,
    healthTimeoutMs: 60000,
    databaseSchema,
    operator: env.GITHUB_ACTOR || env.OPERATOR || "local",
    runId: env.GITHUB_RUN_ID || `local-${randomUUID().slice(0, 8)}`,
    tarball: env.ARTIFACT_TARBALL ? resolve(env.ARTIFACT_TARBALL) : null,
    manifest: env.ARTIFACT_MANIFEST ? resolve(env.ARTIFACT_MANIFEST) : null,
  };
}

export function buildDeployPlan(cfg) {
  const steps = [
    ["verify-artifact", "校验 tarball SHA-256 与 manifest 一致"],
    ["acquire-lock", "获取发布锁（存在即拒绝并发部署）"],
    ["unpack", "解包并落位 releases/<sha>（不可变目录）"],
    ["verify-unpacked", "校验解包目录内容摘要与 manifest"],
    ["stop-current", cfg.serviceControl === "none" ? "无 SERVICE_CONTROL：人工停旧进程" : `停止当前服务 ${cfg.serviceName}`],
    ["switch-run-target", "原子切换 current → releases/<sha>（候选运行目标）"],
    ["migrate", `由 artifact 自身 migrator 迁移 schema=${cfg.databaseSchema}（失败不激活，自动回切）`],
    ["start-candidate", cfg.serviceControl === "none" ? "无 SERVICE_CONTROL：人工启动候选" : `启动 ${cfg.serviceName}（ExecStart 解析 current）`],
    ["health", `轮询 ${cfg.healthUrl} 就绪（超时 ${cfg.healthTimeoutMs}ms；失败自动回切旧运行目标）`],
    ["activate", "health 通过后写 state：current=<sha>，previous=旧版"],
  ];
  return steps.map(([step, desc]) => ({ step, desc }));
}

export function buildRollbackPlan(cfg, target) {
  const steps = [
    ["verify-release", `校验目标 release（${target}）完整性与 manifest`],
    ["check-journal-prefix", "校验目标迁移 journal 是当前 journal 的前缀（兼容校验，不做 down migration）"],
    ["stop-current", cfg.serviceControl === "none" ? "无 SERVICE_CONTROL：人工停当前" : `停止 ${cfg.serviceName}`],
    ["switch-run-target", `原子切换 current → releases/${target}（回滚运行目标）`],
    ["start-previous", cfg.serviceControl === "none" ? "无 SERVICE_CONTROL：人工启动目标版本" : `启动 ${cfg.serviceName}`],
    ["health", `轮询 ${cfg.healthUrl} 就绪（超时 ${cfg.healthTimeoutMs}ms；失败自动回切）`],
    ["activate-rollback", "health 通过后写 state：current=<target>，previous=旧版"],
  ];
  return steps.map(([step, desc]) => ({ step, desc }));
}

export function printPlan(plan) {
  console.log("\n计划：");
  plan.forEach((p, i) => console.log(`  ${i + 1}. [${p.step}] ${p.desc}`));
}

export function isPrefix(prefixArr, fullArr) {
  if (prefixArr.length > fullArr.length) return false;
  return prefixArr.every((tag, i) => tag === fullArr[i]);
}

export async function readState(statePath) {
  if (!existsSync(statePath)) return { schemaVersion: 1, current: null, previous: null, updatedAt: null };
  return JSON.parse(await readFile(statePath, "utf8"));
}

export async function writeState(statePath, state) {
  const tmp = `${statePath}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, statePath);
}

/** 单测/执行共用：解析回滚目标。 */
export function resolveRollbackTarget(state, cliTo) {
  if (cliTo !== null && !SHA.test(cliTo)) throw new Error(`--to 非法 SHA: ${cliTo}`);
  const target = cliTo || state.previous;
  if (!target) throw new Error("无 previous 版本可回滚（首次发布无上一版）");
  return target;
}

/**
 * 原子切换 current 运行目标 → releases/<sha>。
 * POSIX：tmp 链接 + rename 覆盖（原子）。Windows：junction（无需管理员）+ 尽力 replace。
 */
export async function setCurrentTarget(cfg, sha) {
  if (!SHA.test(sha)) throw new Error(`非法 release SHA: ${sha}`);
  const dest = join(cfg.releasesDir, sha);
  if (!existsSync(join(dest, "dist/main.js"))) throw new Error(`release 目录不存在或未就绪: ${sha}`);
  const link = cfg.currentLink;
  const tmp = `${link}.tmp-${randomUUID()}`;
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(dest, tmp, type);
  try {
    await rename(tmp, link);
  } catch {
    await rm(link, { force: true, recursive: true });
    await rename(tmp, link);
  }
}

/** 读取 current 运行目标指向的 release SHA；无/非法返回 null。 */
export async function currentTargetSha(cfg) {
  if (!existsSync(cfg.currentLink)) return null;
  let target;
  try {
    target = await readlink(cfg.currentLink);
  } catch {
    return null;
  }
  const sha = basename(resolve(target));
  return SHA.test(sha) ? sha : null;
}

/* ---------------- 内部实现 ---------------- */

async function appendAudit(cfg, entry) {
  // 审计写入失败不得回滚已激活的部署/回滚（F5）：记录告警并继续，
  // 否则 activate 之后的审计异常会让运行目标与 state 处于不一致状态。
  try {
    await ensureDir(cfg.auditDir);
    const line = JSON.stringify(
      sanitizeForAudit({ ...entry, at: new Date().toISOString(), operator: cfg.operator, runId: cfg.runId }),
    );
    await writeFile(join(cfg.auditDir, "release.jsonl"), `${line}\n`, { flag: "a" });
  } catch (error) {
    console.error(`审计写入失败（非致命，不改变已激活状态）：${error instanceof Error ? error.message : error}`);
  }
}

async function acquireLock(cfg) {
  await ensureDir(cfg.lockDir);
  try {
    await mkdir(join(cfg.lockDir, "deploy.lock"), { recursive: false });
  } catch {
    throw new Error("发布锁已存在（并发部署或上次未清理），拒绝继续");
  }
}

async function releaseLock(cfg) {
  await rm(join(cfg.lockDir, "deploy.lock"), { recursive: true, force: true });
}

/**
 * 失败时是否清理候选目录 `releases/<sha>`。
 *
 * 清理本身是为了避免残留目录让同一不可变 artifact 因“目录已存在”永久无法重试（F4）；
 * 但只允许由**创建了该目录、且仍持有发布锁**的那次调用执行（F8）：并发 `deploy --apply`
 * 对同一 SHA 会同时通过锁前的存在性检查，抢锁失败的一方 `locked === false`，
 * 若其仍做无条件清理，就会删除持锁者正在解包、迁移或已经激活运行的目录——导致获胜部署
 * 中途失败，或 state.current 记录到一个已被删除的 release，而服务进程的文件已不存在。
 */
export function shouldCleanupCandidate({ activated, createdReleaseDir, locked }) {
  return !activated && createdReleaseDir && locked;
}

async function readAppEnvFile(cfg) {
  if (!cfg.appEnvFile || !existsSync(cfg.appEnvFile)) return {};
  const out = {};
  for (const raw of (await readFile(cfg.appEnvFile, "utf8")).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function readJournalTags(releaseRootDir) {
  const p = join(releaseRootDir, "dist/infrastructure/persistence/migrations/meta/_journal.json");
  const data = JSON.parse(await readFile(p, "utf8"));
  if (!Array.isArray(data?.entries)) throw new Error(`journal 非法: ${p}`);
  return data.entries.map((e) => e.tag);
}

/**
 * release 目录内容摘要：排除部署侧后写入的 manifest.json，使校验范围与构建时
 * 计算 rootDigestSha256 的 stage 范围一致（F1/F6：否则每次 deploy/rollback 必失败）。
 */
export async function releaseTreeDigest(releaseDir) {
  return computeTreeDigest(releaseDir, { exclude: ["manifest.json"] });
}

/** 回滚必须能真正切换并重启进程：无服务控制时拒绝，避免假成功（F3/F7）。 */
export function assertRollbackServiceControl(cfg) {
  if (cfg.serviceControl === "none") {
    throw new Error(
      "SERVICE_CONTROL=none 不支持回滚：无法停止当前进程/启动目标版本，只会切换链接并产生错误的运行版本记录。请配置 systemctl/docker（TEX-41/用户决策）。",
    );
  }
}

async function verifyReleaseDir(cfg, sha) {
  const dir = join(cfg.releasesDir, sha);
  if (!existsSync(join(dir, "dist/main.js")) || !existsSync(join(dir, "manifest.json"))) {
    throw new Error(`release ${sha} 不完整（缺 dist/main.js 或 manifest.json）`);
  }
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const digest = await releaseTreeDigest(dir);
  if (digest.digest !== manifest.rootDigestSha256) throw new Error(`release ${sha} 内容摘要不匹配 manifest`);
}

async function serviceCtl(cfg, verb) {
  if (!SERVICE_VERBS.has(verb)) throw new Error(`不允许的服务控制动词: ${verb}`);
  if (cfg.serviceControl === "none") return null;
  const argv = cfg.serviceControl === "systemctl" ? ["systemctl", verb, cfg.serviceName] : ["docker", verb, cfg.serviceName];
  return runShell(argv, {});
}

async function waitHealth(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return;
    } catch {
      /* 未就绪 */
    }
    if (Date.now() >= deadline) throw new Error(`健康检查未就绪：${url}`);
    await sleep(1000);
  }
}

async function unpackTarball(cfg, sha) {
  await ensureDir(cfg.releasesDir);
  const dest = join(cfg.releasesDir, sha);
  await mkdir(dest);
  const res = await runShell(["tar", "--force-local", "-xzf", slash(cfg.tarball), "-C", slash(dest)], {});
  if (res.code !== 0) throw new Error(`解压失败：${res.stderr.slice(-2000)}`);
  const staged = join(dest, "stage");
  if (existsSync(staged)) {
    for (const name of await readdir(staged)) {
      await rename(join(staged, name), join(dest, name));
    }
    await rm(staged, { recursive: true, force: true });
  }
  await writeFile(join(dest, "manifest.json"), await readFile(cfg.manifest, "utf8"), "utf8");
  return dest;
}

async function runPhased(plan, handler) {
  for (const p of plan) {
    try {
      await handler(p);
    } catch (error) {
      error.failedPhase = p.step;
      console.error(`\n步骤 [${p.step}] 失败：${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }
}

/** 失败恢复：回切运行目标到 oldTarget，并尽量把旧服务拉回。 */
async function restoreOldTarget(cfg, oldTarget) {
  const running = await currentTargetSha(cfg);
  if (oldTarget === null) {
    await rm(cfg.currentLink, { force: true, recursive: true }).catch(() => undefined);
    return;
  }
  if (running !== oldTarget) {
    console.error(`恢复运行目标 current -> releases/${oldTarget}`);
    await setCurrentTarget(cfg, oldTarget);
  }
  if (cfg.serviceControl !== "none") {
    // 用 restart 而非 start：候选可能已在运行，start 对运行中的单元是 no-op，
    // 会留下候选进程继续服务并让后续 health 误判为“已恢复旧版”（F2）。
    const recovery = await serviceCtl(cfg, RECOVERY_SERVICE_VERB);
    if (recovery && recovery.code !== 0) {
      console.error(`旧版本恢复（${RECOVERY_SERVICE_VERB}）失败，需人工介入：${recovery.stderr.slice(-1000)}`);
      return;
    }
    try {
      await waitHealth(cfg.healthUrl, cfg.healthTimeoutMs);
      console.error("旧版本已恢复并通过健康检查");
    } catch (e) {
      console.error(`旧版本健康检查未通过，需人工介入：${e.message}`);
    }
  }
}

async function execDeploy(cfg, plan) {
  const manifest = JSON.parse(await readFile(cfg.manifest, "utf8"));
  const sha = manifest.artifact?.gitSha;
  if (!SHA.test(sha || "")) throw new Error("manifest.artifact.gitSha 缺失或非法");
  const oldTarget = await currentTargetSha(cfg);
  if (cfg.serviceControl === "none" && oldTarget !== null) {
    throw new Error("SERVICE_CONTROL=none 且有当前运行版本：无法安全停旧。请配置 systemctl/docker（TEX-41/用户决策）或人工停旧后重跑。");
  }
  if (existsSync(join(cfg.releasesDir, sha))) throw new Error(`release ${sha} 已存在，不可变目录拒绝覆盖`);

  let locked = false;
  let switched = false;
  let stopped = false;
  let activated = false;
  // 候选目录是否由本次调用落位。并发 deploy 对同一 SHA 会同时通过上面的存在性检查，
  // 抢锁失败的一方若也清理，会删掉持锁者正在解包/运行的 releases/<sha>（F8）。
  let createdReleaseDir = false;
  try {
    await runPhased(plan, async (p) => {
      switch (p.step) {
        case "verify-artifact": {
          const actual = await sha256OfFile(cfg.tarball);
          if (actual !== manifest.artifact?.tarballSha256) {
            throw new Error(`tarball SHA-256 不匹配：expect ${manifest.artifact.tarballSha256} actual ${actual}`);
          }
          break;
        }
        case "acquire-lock":
          await acquireLock(cfg);
          locked = true;
          break;
        case "unpack":
          // 解包前标记：部分解包失败同样需要清理（F4），而到达本步骤即已持有发布锁。
          createdReleaseDir = true;
          await unpackTarball(cfg, sha);
          break;
        case "verify-unpacked":
          await verifyReleaseDir(cfg, sha);
          break;
        case "stop-current": {
          if (cfg.serviceControl !== "none" && oldTarget !== null) {
            const r = await serviceCtl(cfg, "stop");
            if (r && r.code !== 0 && r.code !== 5) throw new Error(`停止当前服务失败：${r.stderr.slice(-1000)}`);
            stopped = true;
          }
          break;
        }
        case "switch-run-target":
          await setCurrentTarget(cfg, sha);
          switched = true;
          break;
        case "migrate": {
          const appEnv = await readAppEnvFile(cfg);
          const res = await runShell(
            ["node", "dist/infrastructure/persistence/migrations/migrate.js"],
            { cwd: join(cfg.releasesDir, sha), env: { ...process.env, ...appEnv, DATABASE_SCHEMA: cfg.databaseSchema } },
          );
          if (res.code !== 0) throw new Error(`迁移失败（exit ${res.code}）：${res.stderr.slice(-2000)}`);
          break;
        }
        case "start-candidate": {
          const r = await serviceCtl(cfg, "start");
          if (r && r.code !== 0) throw new Error(`启动候选失败：${r.stderr.slice(-1000)}`);
          break;
        }
        case "health":
          await waitHealth(cfg.healthUrl, cfg.healthTimeoutMs);
          break;
        case "activate":
          await writeState(cfg.statePath, {
            schemaVersion: 1,
            current: sha,
            previous: oldTarget,
            updatedAt: new Date().toISOString(),
          });
          activated = true;
          break;
        default:
          throw new Error(`未实现步骤 ${p.step}`);
      }
      await appendAudit(cfg, { action: "deploy", phase: p.step, sha, result: "ok" });
    });
    console.log(`\ndeploy ${sha} 完成：current 已切换并激活。`);
  } catch (error) {
    if (switched || stopped) await restoreOldTarget(cfg, oldTarget);
    if (shouldCleanupCandidate({ activated, createdReleaseDir, locked })) {
      await removeTree(join(cfg.releasesDir, sha)).catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) await releaseLock(cfg);
  }
}

async function execRollback(cfg, plan, target) {
  assertRollbackServiceControl(cfg);
  let locked = false;
  let oldTarget = null;
  let switched = false;
  let stopped = false;
  try {
    // 回滚与 deploy 共用同一把发布锁，避免并发 deploy/rollback 竞争 current 与 state.json。
    await acquireLock(cfg);
    locked = true;
    const state = await readState(cfg.statePath);
    oldTarget = state.current;
    if (!oldTarget) throw new Error("当前无运行版本可回滚");
    await runPhased(plan, async (p) => {
      switch (p.step) {
        case "verify-release":
          await verifyReleaseDir(cfg, target);
          break;
        case "check-journal-prefix": {
          const currentTags = await readJournalTags(join(cfg.releasesDir, oldTarget));
          const targetTags = await readJournalTags(join(cfg.releasesDir, target));
          if (!isPrefix(targetTags, currentTags)) {
            throw new Error(`目标 ${target} 的迁移 journal 不是当前 ${oldTarget} 的前缀；禁止盲目 down migration（schema/恢复语义归 TEX-42）`);
          }
          break;
        }
        case "stop-current": {
          if (cfg.serviceControl !== "none") {
            const r = await serviceCtl(cfg, "stop");
            if (r && r.code !== 0 && r.code !== 5) throw new Error(`停止失败：${r.stderr.slice(-1000)}`);
            stopped = true;
          }
          break;
        }
        case "switch-run-target":
          await setCurrentTarget(cfg, target);
          switched = true;
          break;
        case "start-previous": {
          const r = await serviceCtl(cfg, "start");
          if (r && r.code !== 0) throw new Error(`启动失败：${r.stderr.slice(-1000)}`);
          break;
        }
        case "health":
          await waitHealth(cfg.healthUrl, cfg.healthTimeoutMs);
          break;
        case "activate-rollback":
          await writeState(cfg.statePath, {
            schemaVersion: 1,
            current: target,
            previous: oldTarget,
            updatedAt: new Date().toISOString(),
          });
          break;
        default:
          throw new Error(`未实现步骤 ${p.step}`);
      }
      await appendAudit(cfg, { action: "rollback", phase: p.step, sha: target, result: "ok" });
    });
    console.log(`\nrollback -> ${target} 完成：current 已切换。`);
  } catch (error) {
    if (switched || stopped) await restoreOldTarget(cfg, oldTarget);
    throw error;
  } finally {
    if (locked) await releaseLock(cfg);
  }
}

async function cmdStatus(cfg) {
  const state = await readState(cfg.statePath);
  const currentLink = await currentTargetSha(cfg);
  const releases = existsSync(cfg.releasesDir) ? (await readdir(cfg.releasesDir)).filter((n) => SHA.test(n)).sort() : [];
  console.log(`release root: ${cfg.releaseRoot}`);
  console.log(`current 运行目标: ${currentLink ?? "（无）"}`);
  console.log(`state.current: ${state.current ?? "（无）"}`);
  console.log(`state.previous: ${state.previous ?? "（无）"}`);
  console.log(`releases: ${releases.length ? "" : "（无）"}`);
  for (const sha of releases) {
    console.log(`  ${sha} ${existsSync(join(cfg.releasesDir, sha, "dist/main.js")) ? "ok" : "INCOMPLETE"}`);
  }
  await appendAudit(cfg, { action: "status", phase: "status", sha: state.current, result: "ok" });
}

/* ---------------- CLI ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(usage());
    process.exit(1);
  }
  const action = argv.shift();
  if (!["status", "deploy", "rollback"].includes(action)) throw new Error(`未知动作 ${action}`);
  const cli = parseCliArgv(argv);
  if (cli.help) {
    console.log(usage());
    return;
  }
  const cfg = wireCli(parseConfig(process.env, action), cli);
  if (action === "status") {
    await cmdStatus(cfg);
    return;
  }
  let plan;
  let target = null;
  if (action === "deploy") {
    plan = buildDeployPlan(cfg);
  } else {
    const state = await readState(cfg.statePath);
    target = resolveRollbackTarget(state, cli.to);
    plan = buildRollbackPlan(cfg, target);
  }
  printPlan(plan);
  if (!cli.apply) {
    console.log("\n[dry-run] 未加 --apply，未执行任何变更。确认后加 --apply 执行。");
    return;
  }
  if (action === "deploy") await execDeploy(cfg, plan);
  else await execRollback(cfg, plan, target);
}

// 仅作为主程序执行时启动 CLI（被单测/工具导入时跳过）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`\nrelease failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
