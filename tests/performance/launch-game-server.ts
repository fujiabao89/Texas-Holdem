/**
 * 压测运行隔离被测 game-server 启动器（TEX-29）。
 *
 * 由 tests/performance/run.ts 以 tsx 子进程运行（同 TEX-28 real launcher 模式）：
 * 1. 为本次运行重建唯一隔离 schema（`tex_perf_<runId>`，run.ts 注入
 *    `DATABASE_SCHEMA`）；
 * 2. 在该 schema 上执行版本化迁移（复用生产迁移目录）；
 * 3. 以生产入口 `apps/game-server/src/main.ts` 启动真实 game-server
 *    （注入 GAME_SERVER_RATE_LIMIT_PROFILE=load-test 供压测档限流）。
 *
 * 只清理本运行派生的 `tex_perf_` schema；parseDatabaseConfig 缺省 DATABASE_SCHEMA
 * 为 "game"，不校验前缀就 DROP 会清掉开发库（docs/06 §2.1：测试只能清理自己创建
 * 的 schema）。run.ts 负责在运行结束后终止子进程并清理 schema（--keep-server 除外）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidSchemaName,
  parseDatabaseConfig,
} from "../../apps/game-server/src/infrastructure/persistence/database/config";

const require = createRequire(import.meta.url);
// pg / drizzle-orm 是 game-server 的依赖（pnpm 严格 node_modules），测试脚本
// 经其包内路径解析，不向根 package.json 添加运行时依赖。
const { Pool } = require("../../apps/game-server/node_modules/pg") as typeof import("pg");
const { drizzle } = require("../../apps/game-server/node_modules/drizzle-orm/node-postgres") as {
  drizzle: typeof import("drizzle-orm/node-postgres").drizzle;
};
const { migrate } = require("../../apps/game-server/node_modules/drizzle-orm/node-postgres/migrator") as {
  migrate: typeof import("drizzle-orm/node-postgres/migrator").migrate;
};

const here = dirname(fileURLToPath(import.meta.url));
const gameServerDir = resolve(here, "../../apps/game-server");
const migrationsFolder = resolve(gameServerDir, "src/infrastructure/persistence/migrations");

async function main(): Promise<void> {
  const config = parseDatabaseConfig();
  assertValidSchemaName(config.schema);
  if (!config.schema.startsWith("tex_perf_")) {
    throw new Error(
      `[perf-launch] 拒绝操作非隔离 schema "${config.schema}"：只允许本次运行派生的 ` +
        `tex_perf_<runId> schema。请经 run.ts 启动（DATABASE_SCHEMA 由 runId 注入）。`,
    );
  }

  // 1) 重建本次运行隔离 schema（同名属于同次中断残留，重建保证确定性）。
  const adminPool = new Pool({ connectionString: config.url, max: 1 });
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${config.schema}`);
  } finally {
    await adminPool.end();
  }

  // 2) 版本化迁移（与生产 db:migrate 相同官方 migrator）。
  const migrationPool = new Pool({ connectionString: config.url, max: 1 });
  migrationPool.on("connect", (client) => {
    void client.query(`SET search_path TO ${config.schema}`);
  });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder, migrationsSchema: config.schema });
    console.log(`[perf-launch] migrations applied to schema "${config.schema}"`);
  } finally {
    await migrationPool.end();
  }

  // 3) 生产入口启动真实 game-server；退出码透传给 run.ts。
  const child = spawn(
    process.execPath,
    [resolve(gameServerDir, "node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
    { cwd: gameServerDir, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
  );
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  child.on("exit", (code, signal) => process.exit(code ?? (signal !== null ? 1 : 0)));
}

main().catch((error: unknown) => {
  console.error(
    `[perf-launch] launcher failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
