#!/usr/bin/env node
/**
 * TEX-40 隔离 artifact HTTP/WS smoke 驱动。
 *
 * 从“打包/解压后的 artifact”（非仓库源码）以生产启动命令运行 Game Server：
 *   1. 由 artifact 自身 migrator 在隔离 PostgreSQL schema 上执行版本化迁移
 *   2. 以 `node dist/main.js`（生产启动命令，NODE_ENV=production）启动服务
 *   3. 轮询 HTTP /health 到可观察就绪（非任意 sleep）
 *   4. 真实 WebSocket Upgrade 到 /api/v1/ws：非法帧 → ERROR(INVALID_MESSAGE)，
 *      未认证 5s → 服务端关闭码 4003 (AUTH_FAILED)
 *   5. 结束清理进程与临时资源（schema / drizzle journal）
 *
 * 要求：--database-url 指向一个**独占/可丢弃**的 PostgreSQL（smoke 会
 * DROP 目标 schema 与共享 drizzle journal，保证可重复）。CI 用独立 service
 * 容器；本地用一次性测试库或 docker 临时实例。
 *
 * 用法：
 *   node artifact-smoke.mjs --runtime-dir <artifact 目录> --database-url <pg url> \
 *        [--schema tex_smoke_x] [--port 0] [--health-timeout-ms 30000] [--keep-schema]
 */

import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { runShell } from "./lib/artifact-lib.mjs";

const HEALTH_PATH = "/health";
const AUTH_FAILED_CLOSE = 4003;
const req = createRequire(import.meta.url);

function usage() {
  return [
    "usage: node artifact-smoke.mjs --runtime-dir <dir> --database-url <pg-url> [--schema NAME] [--port P]",
    "  --runtime-dir  解包后的 artifact 根目录（须含 dist/main.js、migrate.js、node_modules）",
    "  --database-url 独占/可丢弃 PostgreSQL 连接串（必填）",
    "  --schema       隔离 schema 名（默认 tex_smoke_<hex>）",
    "  --port         Game Server 端口（默认自动挑选空闲端口）",
    "  --keep-schema  结束时保留 schema（用于人工检查）",
  ].join("\n");
}

async function parseArgs(argv) {
  const o = { runtimeDir: null, databaseUrl: null, schema: null, port: 0, healthTimeoutMs: 30000, keepSchema: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--runtime-dir") o.runtimeDir = resolve(argv[++i]);
    else if (a === "--database-url") o.databaseUrl = argv[++i];
    else if (a === "--schema") o.schema = argv[++i];
    else if (a === "--port") o.port = Number.parseInt(argv[++i], 10);
    else if (a === "--health-timeout-ms") o.healthTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === "--keep-schema") o.keepSchema = true;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`未知参数 ${a}\n${usage()}`);
  }
  if (!o.runtimeDir || !o.databaseUrl) throw new Error(`--runtime-dir 与 --database-url 必填\n${usage()}`);
  return o;
}

function pickFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

function waitHealthy(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`game-server 提前退出（code=${child.exitCode}）\n${child.readLogs()}`);
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const body = await res.json();
          if (body?.status === "ok") return body;
        }
      } catch {
        /* 未就绪，继续轮询 */
      }
      if (Date.now() >= deadline) throw new Error(`/health 未在 ${timeoutMs}ms 内就绪\n${child.readLogs()}`);
      await sleep(250);
    }
  })();
}

function runServer(runtimeDir, env, port) {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: runtimeDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => {
    logs += d;
  });
  child.stderr.on("data", (d) => {
    logs += d;
  });
  child.readLogs = () => logs;
  return child;
}

function stopServer(child, graceMs = 12000) {
  return new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      res();
    });
    child.once("error", () => res());
  });
}

async function runWsAssertions(wsUrl) {
  const WebSocket = req("ws");
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let sawErrorFrame = false;
    const ws = new WebSocket(wsUrl);
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(closeTimer);
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      if (err) rejectPromise(err);
      else resolvePromise(true);
    };

    const openTimer = setTimeout(() => done(new Error("WS 打开超时")), 8000);
    ws.on("open", () => {
      clearTimeout(openTimer);
      process.stdout.write("  WS open（101 Upgrade 成功）\n");
      ws.send("this is not json");
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return done(new Error(`收到非法 WS 帧: ${data}`));
      }
      if (msg.type === "ERROR" && msg.payload?.code === "INVALID_MESSAGE") {
        sawErrorFrame = true;
        process.stdout.write("  非法帧 -> ERROR/INVALID_MESSAGE（协议 Envelope 符合预期）\n");
        return;
      }
      done(new Error(`收到未预期 WS 消息: ${JSON.stringify(msg)}`));
    });
    ws.on("close", (code) => {
      if (!sawErrorFrame) return done(new Error(`未先收到 INVALID_MESSAGE 即关闭（code=${code}）`));
      if (code !== AUTH_FAILED_CLOSE) {
        return done(new Error(`期望关闭码 ${AUTH_FAILED_CLOSE}(AUTH_FAILED)，实际 ${code}`));
      }
      process.stdout.write(`  未认证 5s -> 服务端关闭码 ${code}（AUTH_FAILED）\n`);
      done(null);
    });
    ws.on("error", (err) => done(new Error(`WS 错误: ${err.message}`)));
    const closeTimer = setTimeout(() => done(new Error("WS 关闭超时（未收到服务端关闭）")), 10000);
  });
}

async function main() {
  const o = await parseArgs(process.argv.slice(2));
  for (const f of [
    join(o.runtimeDir, "dist/main.js"),
    join(o.runtimeDir, "dist/infrastructure/persistence/migrations/migrate.js"),
    join(o.runtimeDir, "node_modules/@texas-holdem/protocol/dist/index.js"),
  ]) {
    if (!existsSync(f)) throw new Error(`runtime-dir 不是有效 artifact：缺少 ${f}`);
  }
  const pkg = JSON.parse(await readFile(join(o.runtimeDir, "package.json"), "utf8"));
  if (pkg.scripts?.start !== "node dist/main.js") {
    throw new Error("artifact package.json 未声明生产启动命令 node dist/main.js");
  }

  const schema = o.schema ?? `tex_smoke_${randomBytes(4).toString("hex")}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`schema 名非法: ${schema}`);
  const port = o.port || (await pickFreePort());
  const baseEnv = { DATABASE_URL: o.databaseUrl, DATABASE_SCHEMA: schema };
  const Pg = req("pg");
  let admin;
  let child = null;
  try {
    admin = new Pg.Pool({ connectionString: o.databaseUrl, max: 1 });
    // 独占库前提：清理共享 drizzle journal 与目标 schema，保证可重复
    await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

    process.stdout.write(`[1/4] 迁移 schema=${schema} ...\n`);
    const mig = await runShell(["node", "dist/infrastructure/persistence/migrations/migrate.js"], {
      cwd: o.runtimeDir,
      env: { ...process.env, ...baseEnv },
    });
    if (mig.code !== 0) throw new Error(`迁移失败（exit ${mig.code}）\n${mig.stderr.slice(-2000)}`);
    process.stdout.write(`[1/4] 迁移完成：${mig.stdout.trim()}\n`);

    process.stdout.write(`[2/4] 启动 game-server（port=${port}）...\n`);
    child = runServer(o.runtimeDir, { ...baseEnv, TOKEN_HMAC_SECRET: "s".repeat(40) }, port);

    const health = await waitHealthy(`http://127.0.0.1:${port}${HEALTH_PATH}`, o.healthTimeoutMs, child);
    process.stdout.write(`[3/4] HTTP /health = ${JSON.stringify(health)}\n`);

    process.stdout.write("[4/4] WS Upgrade /api/v1/ws ...\n");
    await runWsAssertions(`ws://127.0.0.1:${port}/api/v1/ws`);

    process.stdout.write("\nsmoke PASS：迁移 + HTTP /health + WS Upgrade/协议关闭均符合预期\n");
  } finally {
    if (child) await stopServer(child);
    if (admin) {
      if (!o.keepSchema) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
        await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE").catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(`\nsmoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
