import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseDatabaseConfig } from "../database/config";

/**
 * 迁移执行入口（docs/03-data-model.md §5.9/§13 决策 1）。
 *
 * 用法（部署/本地，在 apps/game-server 源码树内执行）：
 * ```bash
 * DATABASE_URL=postgres://... DATABASE_SCHEMA=game \
 *   pnpm --filter @texas-holdem/game-server db:migrate
 * ```
 *
 * - 使用 drizzle-orm 官方 migrator 读取 `meta/_journal.json`，按序执行
 *   版本化 SQL（含手写的 DEFERRABLE 复合外键与最小权限迁移）。
 * - 目标 schema 由 `DATABASE_SCHEMA` 决定（默认 `game`）；schema 不存在时创建。
 * - 禁止对共享环境使用 `drizzle-kit push` 代替迁移。
 */

async function main(): Promise<void> {
  const config = parseDatabaseConfig();
  const pool = new Pool({ connectionString: config.url, max: 1 });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
    // 迁移连接与运行时一致：search_path 指向目标 schema，
    // 迁移 SQL（无 schema 前缀）据此落到正确位置。
    await pool.query(`SET search_path TO ${config.schema}`);
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: join(__dirname, ".") });
    console.log(`migrations applied to schema "${config.schema}"`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // 不打印 DATABASE_URL 或错误对象全文（可能含连接串），只输出消息。
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
