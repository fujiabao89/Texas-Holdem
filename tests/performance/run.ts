/**
 * 性能压测 CLI 入口（TEX-29）。
 *
 *   pnpm test:perf -- --scenario smoke [--sha <hex>]
 *   pnpm test:perf -- --scenario normal --sha <hex> [--rooms..]   （Release/隔离环境）
 *
 * 职责：解析参数 → 运行计划（reducedEvidence 如实标注）→ 拉起或接入隔离被测实例
 * → 执行场景 → 汇总指标 → 脱敏产物 summary.json → SLO 门禁（仅正式场景）→ 清理 →
 * 退出码。退出码：0=通过；1=失败；2=参数/环境错误；3=证据不足/缩减（不折算通过）。
 *
 * 正式场景产物绑定 --sha；产物只落聚合统计与计数，不含任何敏感值（redaction 兜底）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus as osCpus, freemem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePerfArgs, USAGE } from "./cli";
import { resolvePlan, SCENARIO_SLO } from "./scenarios";
import { MetricsCollector } from "./metrics";
import { evaluateSlo, overallVerdict } from "./gates";
import { describeLatencies, ratioOrNull } from "./stats";
import { redactJson, sensitiveKeysIn } from "./redaction";
import { serverInfoFrom, PerfHttp } from "./engine";
import { startOneTable, runSustained, runReconnectStorm } from "./driver";
import type { RoomSession } from "./engine";
import {
  createRealRunId,
  resolveRealDatabaseUrl,
  withApplicationName,
} from "../e2e/real/support/run-identity";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const hereRequire = createRequire(import.meta.url);
const DEFAULT_OUT = resolve(REPO_ROOT, "tests/performance/.artifacts");

const EXIT = { pass: 0, fail: 1, usage: 2, insufficient: 3 } as const;

function nowIso(): string {
  return new Date().toISOString();
}

/** FNV-1a 派生 [0, 2^32) 内整数 seed（game-server TEX_TEST_RNG_SEED 要求）。 */
function deriveSeedInt(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as { port: number };
  const port = address.port;
  await new Promise<void>((close) => server.close(() => close()));
  return port;
}

async function waitForHealth(baseUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`被测服务 ${baseUrl}/health 在 ${timeoutMs}ms 内未就绪：${lastError}`);
}

interface LocalHandle {
  readonly child: ReturnType<typeof spawn>;
  readonly schema: string;
  readonly port: number;
}

function requireWorkspaceDists(): void {
  const missing: string[] = [];
  for (const pkg of ["protocol", "poker-engine"]) {
    const entry = resolve(REPO_ROOT, `packages/${pkg}/dist/index.js`);
    if (!existsSync(entry)) missing.push(`packages/${pkg}（缺 dist/index.js）`);
  }
  if (missing.length > 0) {
    throw new Error(
      `本地拉起需要先构建 workspace 包：${missing.join("、")}。请先运行 ` +
        `pnpm --filter @texas-holdem/poker-engine build && pnpm --filter @texas-holdem/protocol build。`,
    );
  }
}

/** 本地拉起隔离被测实例（迁移 + 生产入口）。run 结束后由 finally 终止并 DROP schema。 */
async function launchLocalServer(
  sha: string | undefined,
  metrics: MetricsCollector,
): Promise<LocalHandle> {
  requireWorkspaceDists();
  if (resolveRealDatabaseUrl(process.env) === undefined) {
    throw new Error(
      "本地压测需要真实 PostgreSQL：请设置 TEX_TEST_DATABASE_URL（或 DATABASE_URL）后重试；" +
        "例如 docker 提供 127.0.0.1:55432 的 postgres。隔离实例用 tex_perf_<runId> schema 自清理。",
    );
  }
  const port = await pickFreePort();
  const runId = createRealRunId();
  const schema = `tex_perf_${runId}`;
  const databaseUrl = withApplicationName(resolveRealDatabaseUrl(process.env), `tex_perf_${runId}`);
  const env: Record<string, string> = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: schema,
    PORT: String(port),
    HOST: "127.0.0.1",
    TOKEN_HMAC_SECRET: "tex29-perf-isolated-token-secret-0000000001",
    GAME_SERVER_RATE_LIMIT_PROFILE: "load-test",
  };
  if (sha !== undefined) env.TEX_TEST_RNG_SEED = String(deriveSeedInt(sha));
  const launcher = resolve(here, "launch-game-server.ts");
  const child = spawn(
    process.execPath,
    [resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), launcher],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"] },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
    metrics.setProcessCrash();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  if (exited) throw new Error("被测服务在 /health 就绪前退出（崩溃）");
  return { child, schema, port };
}

async function dropSchema(schema: string): Promise<void> {
  const { Pool } = hereRequire(
    resolve(REPO_ROOT, "apps/game-server/node_modules/pg"),
  ) as typeof import("pg");
  const pool = new Pool({ connectionString: resolveRealDatabaseUrl(process.env), max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

function machineMeta(): Record<string, string | number | boolean | null> {
  const models = osCpus();
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpuModel: models.length > 0 ? models[0]!.model.trim() : "unknown",
    cpus: models.length,
    freeMemGiB: Math.round((freemem() / 1024 ** 3) * 10) / 10,
  };
}

interface SummaryDoc {
  meta: Record<string, string | number | boolean | null>;
  load: {
    scenario: string;
    rooms: number;
    players: number;
    durationMs: number;
    roomsStarted: number;
    opTarget: number | undefined;
    reducedEvidence: boolean;
  };
  metrics: Record<string, unknown>;
  gates?: unknown;
}

function summarizePlan(
  plan: ReturnType<typeof resolvePlan>,
  metrics: MetricsCollector,
  meta: Record<string, string | number | boolean | null>,
): SummaryDoc {
  const snapshot = metrics.snapshot();
  const actionLatency =
    snapshot.actionLatencyMs.length > 0 ? describeLatencies(snapshot.actionLatencyMs) : null;
  const reconnectLatency =
    snapshot.reconnectLatencyMs.length > 0 ? describeLatencies(snapshot.reconnectLatencyMs) : null;
  return {
    meta,
    load: {
      scenario: plan.name,
      rooms: plan.rooms,
      players: plan.players,
      durationMs: plan.durationMs,
      roomsStarted: 0,
      opTarget: plan.target.opCount,
      reducedEvidence: plan.reducedEvidence,
    },
    metrics: {
      ...snapshot,
      actionLatency,
      reconnectLatency,
      business5xxRate: ratioOrNull(snapshot.http5xx, snapshot.httpRequests),
      unexpectedDisconnectRate: ratioOrNull(snapshot.unexpectedDisconnect, snapshot.wsConnections),
      recoveryErrorRate: ratioOrNull(snapshot.recoveryFailures, snapshot.recoveryAttempts),
    },
  };
}

function functionalVerdict(metrics: MetricsCollector): "pass" | "fail" {
  const snapshot = metrics.snapshot();
  const bad =
    snapshot.invariantViolations +
    snapshot.sequenceViolations +
    (snapshot.processCrash ? 1 : 0) +
    snapshot.http5xx;
  return bad === 0 && snapshot.actionLatencyMs.length > 0 ? "pass" : "fail";
}

async function main(): Promise<number> {
  const startedAtIso = nowIso();
  let args;
  try {
    args = parsePerfArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `参数错误：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return EXIT.usage;
  }
  let plan;
  try {
    plan = resolvePlan(args.scenario, {
      rooms: args.rooms,
      players: args.players,
      durationMs: args.durationMs,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }
  const sha = args.sha ?? process.env.TEX_PERF_SHA ?? process.env.GITHUB_SHA ?? undefined;
  if (plan.target.releaseGate && sha === undefined) {
    console.error(`正式场景 ${plan.name} 必须 --sha <hex>（绑定产物与门禁的候选提交）`);
    return EXIT.usage;
  }
  const outDir =
    args.out === "tests/performance/.artifacts" ? DEFAULT_OUT : resolve(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `perf-${plan.name}-${new Date(startedAtIso).getTime()}.json`);

  const metrics = new MetricsCollector();
  let local: LocalHandle | null = null;
  try {
    let serverBase = args.baseUrl;
    if (serverBase === undefined) {
      local = await launchLocalServer(sha, metrics);
      serverBase = `http://127.0.0.1:${local.port}`;
    }
    const server = serverInfoFrom(serverBase!);
    const http = new PerfHttp(serverBase!, metrics);

    let roomsStarted = 0;
    if (plan.name === "reconnect") {
      const rooms: RoomSession[] = [];
      for (let i = 0; i < plan.rooms; i++) {
        rooms.push(
          await startOneTable({ http, server, metrics, roomTag: String(i), players: plan.players }),
        );
      }
      roomsStarted = rooms.length;
      await runReconnectStorm(rooms, server, metrics, plan.target.opCount ?? 500);
      for (const room of rooms) {
        for (const session of [room.host, ...room.players]) {
          await closeSessionSafe(session);
        }
      }
    } else {
      const outcome = await runSustained({
        http,
        server,
        metrics,
        rooms: plan.rooms,
        players: plan.players,
        durationMs: plan.durationMs,
      });
      roomsStarted = outcome.roomsStarted;
    }

    const meta: Record<string, string | number | boolean | null> = {
      scenario: plan.name,
      sha: sha ?? null,
      label: args.label ?? null,
      runId: createRealRunId(),
      startedAtIso,
      ...machineMeta(),
      note: plan.reducedEvidence
        ? "缩减运行（参数低于官方目标），不作为 Release 证据；延迟为 driver 观测值（含本机回环 RTT），Release 以 /metrics 的 texas_action_to_event_seconds 服务端直方图为准。"
        : "延迟为 driver 观测值（含本机回环 RTT）；Release 以 /metrics 服务端直方图为准。",
    };
    const summary = summarizePlan(plan, metrics, meta);
    summary.load.roomsStarted = roomsStarted;

    // 门禁判定：正式场景判 SLO；smoke 判功能不变量。
    const checks = plan.target.releaseGate ? SCENARIO_SLO[plan.name] : [];
    const gateResults = evaluateSlo(checks, metrics.snapshot());
    const verdict = plan.target.releaseGate
      ? overallVerdict(gateResults)
      : functionalVerdict(metrics);
    summary.gates = { checks: gateResults, verdict };

    const redacted = redactJson(summary);
    const leaked = sensitiveKeysIn(redacted);
    if (leaked.length > 0) {
      console.error(`产物含敏感键，拒绝写盘：${leaked.join(", ")}`);
      return EXIT.fail;
    }
    writeFileSync(outFile, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
    console.log(`[perf] 产物：${outFile}`);
    console.log(
      `[perf] 场景=${plan.name} rooms=${plan.rooms} players=${plan.players} durationMs=${plan.durationMs}（reduced=${plan.reducedEvidence}）`,
    );
    console.log(`[perf] 门禁 verdict=${verdict}`);

    if (verdict === "fail") return EXIT.fail;
    if (plan.reducedEvidence) {
      console.error("[perf] 缩减运行不作为 Release 证据；证据完整度见 summary.gates。");
      return EXIT.insufficient;
    }
    if (verdict === "pass") return EXIT.pass;
    return EXIT.insufficient;
  } catch (error) {
    console.error(`[perf] 运行失败：${error instanceof Error ? error.message : String(error)}`);
    return EXIT.fail;
  } finally {
    if (local !== null) {
      local.child.kill("SIGKILL");
      try {
        await dropSchema(local.schema);
      } catch {
        // schema 清理失败不掩盖主结果
      }
    }
  }
}

async function closeSessionSafe(session: {
  ws: { close(): void; closed: Promise<unknown> } | null;
}): Promise<void> {
  const ws = session.ws;
  if (ws === null) return;
  session.ws = null;
  ws.close();
  await ws.closed.catch(() => undefined);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
