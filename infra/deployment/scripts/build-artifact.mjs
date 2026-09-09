#!/usr/bin/env node
/**
 * TEX-40 最小运行发布产物构建入口（可重复、可审计）。
 *
 * 产物 = Game Server 编译产物 + 运行时生产依赖 + workspace 包编译产物 +
 *       版本化迁移执行所需 SQL/journal（已随源码审查）+ runtime package.json。
 * 不含：monorepo 源码、pnpm store、开发依赖、Next.js/Web 产物、任何 Secret。
 *
 * 目标机只接收本产物与显式环境注入；不得 clone monorepo 或执行
 * drizzle-kit generate/push。迁移由产物内 migrator 执行。
 *
 * 用法（仓库干净 checkout，pnpm install 之后）：
 *   node infra/deployment/scripts/build-artifact.mjs \
 *     --out-dir <dir> [--no-archive] [--label game-server]
 *
 * 步骤：
 *   1. 同一 SHA 下构建 game-server 及依赖 workspace 包（turbo, --force 防缓存）
 *   2. pnpm deploy --legacy --prod 得到自包含 node_modules（无 devDeps/store）
 *   3. 用刚构建的 dist 覆盖部署目录，并把 migrations/*.sql + meta/_journal 补入
 *      dist 迁移路径（migrator 以 __dirname 读取）
 *   4. 裁剪源码/开发文件；补全 workspace 包自身传递依赖（如 zod）为真实副本
 *   5. 自检：模块解析断言 + 生产启动命令冒烟到“缺 DATABASE_URL”即证明依赖闭环
 *   6. 写 manifest（git SHA/构建时间/Node/pnpm/lockfile 摘要/文件 sha/启动与迁移命令），
 *      生成 tar.gz 并计算 tarball sha256
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readdir, readFile, copyFile, cp, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  checksumsForFiles,
  computeTreeDigest,
  ensureDir,
  removeTree,
  runShell,
  sha256OfFile,
  writeJson,
} from "./lib/artifact-lib.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
/** Windows 下传给 tar/shell 需正斜杠形式。 */
const slash = (p) => p.replace(/\\/g, "/");
const GAME_SERVER = "apps/game-server";
const MIGRATIONS_SRC = join(GAME_SERVER, "src/infrastructure/persistence/migrations");

function usage() {
  return [
    "usage: node build-artifact.mjs --out-dir <dir> [--no-archive] [--label game-server]",
    "                       [--expect-git-sha <40hex>] [--work-dir <dir>]",
    "  --out-dir          产物输出目录（tarball + manifest）",
    "  --expect-git-sha   期望构建 HEAD 的 40 位 commit SHA；不一致则中止",
    "  --no-archive       只生成 manifest/目录摘要，不打包 tar.gz（本地隔离验证用）",
    "  --work-dir         staging 目录（默认系统临时目录，仓库外；避免 pnpm deploy 改写仓库 node_modules）",
    "注意：必须从干净 checkout（无 tracked/untracked 改动）构建；否则拒绝，防止未提交代码被标记为 HEAD artifact。",
  ].join("\n");
}

async function parseArgs(argv) {
  const out = { outDir: null, label: "game-server", archive: true, workDir: null, expectGitSha: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out-dir") out.outDir = resolve(argv[++i]);
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--work-dir") out.workDir = resolve(argv[++i]);
    else if (a === "--expect-git-sha") out.expectGitSha = argv[++i];
    else if (a === "--no-archive") out.archive = false;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${a}\n${usage()}`);
    }
  }
  if (!out.outDir) throw new Error(`缺少 --out-dir\n${usage()}`);
  if (out.expectGitSha !== null && !/^[0-9a-f]{40}$/.test(out.expectGitSha)) {
    throw new Error(`--expect-git-sha 必须是 40 位十六进制 commit SHA（得到 ${out.expectGitSha}）`);
  }
  return out;
}

/** 拒绝任何 tracked/untracked 工作树改动：防止把未提交代码标记为 HEAD artifact。 */
async function assertCleanTree(repoRoot) {
  const res = await runShell(["git", "status", "--porcelain"], { cwd: repoRoot });
  if (res.code !== 0) throw new Error(`无法读取 git 工作树状态：${res.stderr}`);
  const dirty = (res.stdout || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (dirty.length > 0) {
    const preview = dirty.slice(0, 10).join("\n");
    throw new Error(
      `工作树不干净：存在 ${dirty.length} 处 tracked/untracked 改动，拒绝构建——本产物会把未提交代码标记为 HEAD artifact。\n请从干净 checkout（无未提交改动）运行 build-artifact。发现改动（前 10 行）：\n${preview}`,
    );
  }
}

/** pnpm 运行预检会在脚本前尝试 install/修剪；CI 下禁用以免误改 node_modules。 */
function stepEnv(overrides = {}) {
  return {
    ...process.env,
    CI: "true",
    npm_config_verify_deps_before_run: "false",
    ...overrides,
  };
}

/** 打印步骤并执行命令；非零退出即抛错（fail-fast）。 */
async function step(argv, opts, label) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const res = await runShell(argv, { ...opts, env: stepEnv(opts.env) });
  if (res.stdout.trim()) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
  if (res.stderr.trim()) process.stdout.write(`[stderr] ${res.stderr.trim()}\n`);
  if (res.code !== 0) {
    throw new Error(`${label} 失败 (exit ${res.code})\n${res.stderr.slice(-4000)}`);
  }
}

async function main() {
  const opts = await parseArgs(process.argv.slice(2));
  // 干净工作树守卫必须在任何写入/构建前执行（防止未提交代码被标记为 HEAD artifact）。
  await assertCleanTree(REPO_ROOT);

  const gitRes = await runShell(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT });
  if (gitRes.code !== 0) throw new Error(`无法读取 git SHA：${gitRes.stderr}`);
  const gitSha = gitRes.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error(`非法 git SHA：${gitSha}`);
  if (opts.expectGitSha !== null && opts.expectGitSha !== gitSha) {
    throw new Error(
      `git HEAD（${gitSha}）与 --expect-git-sha（${opts.expectGitSha}）不一致；必须在目标提交上从干净 checkout 构建。`,
    );
  }

  await ensureDir(opts.outDir);
  const pnpmRes = await runShell(["pnpm", "-v"], { cwd: REPO_ROOT });
  const pnpmVersion = (pnpmRes.stdout || "").trim() || "unknown";

  // staging 放系统临时目录（仓库外）：pnpm deploy 目标在仓库内会改写根 node_modules
  //（把 dev 依赖裁成 production），影响同一 checkout 后续仍需仓库 devDeps 的步骤。
  const workDir = opts.workDir ?? join(tmpdir(), `tex-artifact-${opts.label}-${gitSha.slice(0, 12)}`);
  await removeTree(workDir).catch(() => undefined);
  await ensureDir(workDir);
  const stageDir = join(workDir, "stage");

  // 1. 按依赖顺序直接 tsc 构建（poker-engine/protocol -> game-server）。
  //    直接调用 tsc 而非 turbo/pnpm run，避免 pnpm 的 verify-deps-before-run
  //    在脚本前自动 install/修剪 node_modules（CI 或版本差异下的非确定性行为）。
  const tscBin = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  for (const pkg of ["packages/poker-engine", "packages/protocol", GAME_SERVER]) {
    await step(
      ["node", tscBin, "-p", join(REPO_ROOT, pkg, "tsconfig.build.json")],
      { cwd: REPO_ROOT },
      `1/6 tsc build ${pkg}`,
    );
  }

  // 2. pnpm deploy 生成自包含 node_modules（生产依赖，无 devDeps）
  await step(
    [
      "pnpm",
      "--filter",
      "@texas-holdem/game-server",
      "deploy",
      "--legacy",
      "--prod",
      "--offline",
      stageDir,
    ],
    { cwd: REPO_ROOT },
    "2/6 pnpm deploy --legacy --prod（自包含 node_modules）",
  );

  // 3. 用刚构建的 dist 覆盖；补齐 migrations SQL/journal 到 dist 迁移路径
  await removeTree(join(stageDir, "dist"));
  await cp(join(REPO_ROOT, GAME_SERVER, "dist"), join(stageDir, "dist"), { recursive: true });
  const destMigrations = join(stageDir, "dist/infrastructure/persistence/migrations");
  const sqlFiles = (await readdir(join(REPO_ROOT, MIGRATIONS_SRC))).filter((f) => f.endsWith(".sql"));
  if (sqlFiles.length === 0) throw new Error("未发现版本化 SQL 迁移");
  for (const f of sqlFiles) {
    await copyFile(join(REPO_ROOT, MIGRATIONS_SRC, f), join(destMigrations, f));
  }
  await cp(join(REPO_ROOT, MIGRATIONS_SRC, "meta"), join(destMigrations, "meta"), { recursive: true });
  const journal = join(destMigrations, "meta/_journal.json");
  await access(journal);
  const journalData = JSON.parse(await readFile(journal, "utf8"));
  if (!Array.isArray(journalData?.entries) || journalData.entries.length !== sqlFiles.length) {
    throw new Error("meta/_journal.json 与 SQL 迁移数量不一致");
  }
  process.stdout.write(`migrations staged: ${sqlFiles.join(", ")}\n`);

  // 4. 裁剪源码/开发文件
  const devJunk = [
    "src",
    "tests",
    "README.md",
    ".env.example",
    ".turbo",
    "drizzle.config.ts",
    "tsconfig.json",
    "tsconfig.build.json",
  ];
  for (const name of devJunk) {
    await removeTree(join(stageDir, name)).catch(() => undefined);
  }
  await ensureWorkspaceDepsSelfContained(stageDir);

  // 5. runtime package.json（覆盖 deploy 复制来的开发 package.json）
  await writeJson(join(stageDir, "package.json"), {
    name: "@texas-holdem/game-server-release",
    private: true,
    version: "0.0.0",
    description: "Game Server 最小运行发布产物（TEX-40；勿在此执行 pnpm install）",
    engines: { node: ">=22" },
    scripts: {
      start: "node dist/main.js",
      migrate: "node dist/infrastructure/persistence/migrations/migrate.js",
    },
  });

  // 5b. 自检：解析断言 + 生产启动命令到“缺 DATABASE_URL”
  const checkPath = join(workDir, "self-check.mjs");
  await writeFile(checkPath, selfCheckSource());
  await step(["node", checkPath, stageDir], { cwd: workDir }, "5/6 自检：模块解析断言（自包含性）");
  const boot = await runShell(["node", join(stageDir, "dist/main.js")], {
    cwd: stageDir,
    env: stepEnv({ TOKEN_HMAC_SECRET: "s".repeat(40), NODE_ENV: "production" }),
  });
  if (boot.code === 0 || !boot.stderr.includes("DATABASE_URL is required")) {
    throw new Error(
      `自检失败：生产启动命令未按预期停于“缺 DATABASE_URL”（exit=${boot.code}）\n${boot.stderr.slice(-2000)}`,
    );
  }
  process.stdout.write("自检：生产启动命令在缺失 DATABASE_URL 处按预期失败（依赖闭环成立）\n");

  // 6. manifest + 可选 tar.gz
  const digest = await computeTreeDigest(stageDir);
  const criticalFiles = [
    "package.json",
    "dist/main.js",
    "dist/infrastructure/persistence/migrations/migrate.js",
    ...sqlFiles.map((f) => `dist/infrastructure/persistence/migrations/${f}`),
    "dist/infrastructure/persistence/migrations/meta/_journal.json",
    "node_modules/@texas-holdem/poker-engine/dist/index.js",
    "node_modules/@texas-holdem/protocol/dist/index.js",
  ];
  const checksums = await checksumsForFiles(stageDir, criticalFiles);
  const lockfileSha = await sha256OfFile(join(REPO_ROOT, "pnpm-lock.yaml"));

  const manifest = {
    schemaVersion: 1,
    artifact: {
      name: opts.label,
      format: opts.archive ? "tar.gz" : "directory",
      gitSha,
      buildTimeUtc: new Date().toISOString(),
      nodeVersion: process.version,
      pnpmVersion,
      lockfileSha256: lockfileSha,
    },
    rootDigestSha256: digest.digest,
    rootFileCount: digest.files,
    checksums,
    commands: {
      start: "node dist/main.js",
      migrate: "node dist/infrastructure/persistence/migrations/migrate.js",
    },
    nodeRuntime: { minMajor: 22 },
    redactionNote: "本 manifest 不含任何 Secret；生产凭据只经环境变量注入。",
  };

  const manifestPath = join(opts.outDir, `${opts.label}-${gitSha}.manifest.json`);
  await writeJson(manifestPath, manifest);

  if (opts.archive) {
    const tarballName = `${opts.label}-${gitSha}.tar.gz`;
    const tarballPath = join(opts.outDir, tarballName);
    await step(
      // Windows 下 tar 需正斜杠路径；--force-local 防盘符冒号被当作 remote host（Linux 无副作用）
      ["tar", "--force-local", "-C", slash(workDir), "-czf", slash(tarballPath), "stage"],
      { cwd: workDir },
      "6/6 打包 tar.gz（符号链接布局保留，Linux 目标可移植）",
    );
    const tarballSha = await sha256OfFile(tarballPath);
    manifest.artifact.tarballName = tarballName;
    manifest.artifact.tarballSha256 = tarballSha;
    await writeJson(manifestPath, manifest);
    await writeFile(`${tarballPath}.sha256`, `${tarballSha}  ${tarballName}\n`, "utf8");
    process.stdout.write(`\nmanifest: ${manifestPath}\ntarball : ${tarballPath} (sha256 ${tarballSha})\n`);
  } else {
    process.stdout.write(`\n[no-archive] stage 保留于 ${stageDir}\nmanifest: ${manifestPath}\n`);
  }
  process.stdout.write(`\nstaging（仓库外，保留供本地 smoke 使用）: ${stageDir}\n`);
  process.stdout.write(`root digest sha256: ${digest.digest}（${digest.files} 个文件）\ngit sha: ${gitSha}\n`);
}

/** 补全 workspace 包自身传递依赖为真实副本（当前场景 protocol -> zod）。 */
async function ensureWorkspaceDepsSelfContained(stageDir) {
  const scopeDir = join(stageDir, "node_modules/@texas-holdem");
  if (!existsSync(scopeDir)) return;
  const pkgNames = await readdir(scopeDir);
  const vstore = join(stageDir, "node_modules/.pnpm");

  for (const pkgName of pkgNames) {
    const pkgDir = join(scopeDir, pkgName);
    const pjPath = join(pkgDir, "package.json");
    if (!existsSync(pjPath)) continue;
    const pkg = JSON.parse(await readFile(pjPath, "utf8"));

    for (const junk of ["src", "tests", "README.md", "tsconfig.json", "tsconfig.build.json", ".turbo"]) {
      await removeTree(join(pkgDir, junk)).catch(() => undefined);
    }

    const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) };
    for (const dep of Object.keys(deps)) {
      const localDir = join(pkgDir, "node_modules", dep);
      if (existsSync(localDir)) continue;
      const candidates = (await readdir(vstore).catch(() => [])).filter((d) =>
        d.startsWith(`${dep}@`),
      );
      candidates.sort(byVersionDesc);
      if (candidates.length === 0) {
        throw new Error(`workspace 包 ${pkgName} 的依赖 ${dep} 无法在产物虚拟 store 中找到`);
      }
      const srcDep = join(vstore, candidates[0], "node_modules", dep);
      await cp(srcDep, localDir, { recursive: true });
      process.stdout.write(`  materialized ${dep} -> ${pkgName}/node_modules\n`);
    }
  }
}

function byVersionDesc(a, b) {
  const pa = versionOf(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = versionOf(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? 1 : -1;
}

function versionOf(pnpmDir) {
  const at = pnpmDir.lastIndexOf("@");
  return at === -1 ? pnpmDir : pnpmDir.slice(at + 1);
}

/** 解析断言脚本源码：要求产物内依赖均解析在 stage 内（自包含）。 */
function selfCheckSource() {
  return `
import { join, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const stage = resolve(process.argv[2]);
const pfx = stage.endsWith(sep) ? stage : stage + sep;
const inside = (p) => resolve(p) === stage || resolve(p).startsWith(pfx);
const bad = [];
const reqMain = createRequire(join(stage, "dist/main.js"));
for (const dep of ["fastify", "@fastify/websocket", "@fastify/rate-limit", "pg", "drizzle-orm", "@texas-holdem/poker-engine", "@texas-holdem/protocol"]) {
  try {
    const r = reqMain.resolve(dep, { paths: [join(stage, "dist")] });
    if (!inside(r)) bad.push(dep + " resolved outside artifact -> " + r);
  } catch (e) { bad.push(dep + " unresolved: " + (e && e.message)); }
}
for (const pkg of ["@texas-holdem/poker-engine", "@texas-holdem/protocol"]) {
  const pkgRoot = join(stage, "node_modules", pkg);
  const meta = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const req = createRequire(join(pkgRoot, "package.json"));
  for (const dep of Object.keys(meta.dependencies || {})) {
    try {
      const r = req.resolve(dep, { paths: [pkgRoot] });
      if (!inside(r)) bad.push(pkg + " -> " + dep + " resolved outside artifact -> " + r);
    } catch (e) { bad.push(pkg + " -> " + dep + " unresolved: " + (e && e.message)); }
  }
}
if (bad.length) { console.error(bad.join("\\n")); process.exit(1); }
console.log("self-check OK: game-server + workspace deps resolve inside artifact");
`;
}

main().catch((error) => {
  console.error(`\nbuild-artifact failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
