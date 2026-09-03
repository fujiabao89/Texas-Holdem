/**
 * TEX-28 真实链路 E2E 的 game-server 启动器。
 *
 * 由 tests/e2e/playwright.real.config.ts 作为 Playwright webServer 进程运行：
 *   pnpm --filter @texas-holdem/game-server exec tsx ../../tests/e2e/real/support/launch-game-server.ts
 *
 * 职责（docs/06 §5 真实 PostgreSQL E2E）：
 * 1. 为本次运行重建唯一隔离 schema（`tex_test_e2e_real_<runId>`，来自
 *    `TEX_E2E_REAL_SCHEMA`，由 Playwright 配置生成）；
 * 2. 在该 schema 上执行版本化迁移（复用生产迁移目录）；
 * 3. 以生产入口 `apps/game-server/src/main.ts` 启动真实 game-server
 *    （注入 TEX_TEST_RNG_SEED 确定性洗牌；不设置时生产默认安全随机）。
 *
 * schema 清理由 global-teardown.ts 负责（DROP SCHEMA CASCADE）；
 * 本脚本只创建本次运行的 schema，不触碰其他 schema（docs/06 §5：测试
 * 只能清理自己创建的数据库 schema）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidSchemaName,
  parseDatabaseConfig,
} from "../../../../apps/game-server/src/infrastructure/persistence/database/config";

const require = createRequire(import.meta.url);
// pg / drizzle-orm 是 game-server 的依赖（pnpm 严格 node_modules），测试脚本
// 经其包内路径解析，不向根 package.json 添加运行时依赖。
const { Pool } = require("../../../../apps/game-server/node_modules/pg") as typeof import("pg");
const { drizzle } = require("../../../../apps/game-server/node_modules/drizzle-orm/node-postgres") as {
  drizzle: typeof import("drizzle-orm/node-postgres").drizzle;
};
const { migrate } = require("../../../../apps/game-server/node_modules/drizzle-orm/node-postgres/migrator") as {
  migrate: typeof import("drizzle-orm/node-postgres/migrator").migrate;
};

const here = dirname(fileURLToPath(import.meta.url));
const gameServerDir = resolve(here, "../../../../apps/game-server");
const migrationsFolder = resolve(gameServerDir, "src/infrastructure/persistence/migrations");

async function main(): Promise<void> {
  const config = parseDatabaseConfig();
  assertValidSchemaName(config.schema);

  // 1) 重建本次运行的隔离 schema（同名 schema 属于同一次中断运行的残留，
  //    重建保证确定性；不匹配其他测试层的 tex_test_<runId> 命名）。
  const adminPool = new Pool({ connectionString: config.url, max: 1 });
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${config.schema}`);
  } finally {
    await adminPool.end();
  }

  // 2) 版本化迁移（与生产 db:migrate 相同的官方 migrator）。
  const migrationPool = new Pool({ connectionString: config.url, max: 1 });
  migrationPool.on("connect", (client) => {
    void client.query(`SET search_path TO ${config.schema}`);
  });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder, migrationsSchema: config.schema });
    console.log(`[e2e-real] migrations applied to schema "${config.schema}"`);
  } finally {
    await migrationPool.end();
  }

  // 3) 生产入口启动真实 game-server；退出码透传给 Playwright。
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
  console.error(`[e2e-real] launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});