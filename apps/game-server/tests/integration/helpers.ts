import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  createDatabase,
  type Database,
} from "../../src/infrastructure/persistence/database";
import type { TestDatabaseContext } from "../../../../tests/support/test-db";

/**
 * Integration 测试数据库基建（TEX-18）。
 *
 * 复用 TEX-12 的 `describeTestDatabase`：每次套件运行持有唯一 `runId`
 * 与独立 `tex_test_<runId>` schema；缺 `TEX_TEST_DATABASE_URL`/`DATABASE_URL`
 * 配置时整组受控跳过（docs/06-testing-strategy.md §2.1）。
 *
 * 流程：CREATE SCHEMA → 在目标 schema 上执行版本化迁移（含手写
 * DEFERRABLE FK 与最小权限迁移）→ 交给仓储层使用 → 结束 DROP SCHEMA CASCADE。
 * 迁移记录表放在同一隔离 schema 内，随 schema 一并清理。
 */

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../src/infrastructure/persistence/migrations", import.meta.url),
);

export interface IntegrationDatabase {
  readonly database: Database;
  readonly schemaName: string;
  /** 管理连接（无 search_path）：用于原生 SQL 断言、SET ROLE 权限测试与清理。 */
  readonly adminPool: Pool;
  readonly url: string;
  end(): Promise<void>;
}

export async function setupIntegrationDatabase(
  context: TestDatabaseContext,
): Promise<IntegrationDatabase> {
  if (!context.available || context.urlSource === undefined) {
    throw new Error("setupIntegrationDatabase requires an available test database context");
  }
  const url = process.env[context.urlSource];
  if (url === undefined || url.trim() === "") {
    throw new Error(`test database url env (${context.urlSource}) is empty`);
  }
  const schemaName = context.schemaName;

  const adminPool = new Pool({ connectionString: url, max: 4 });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  const migrationPool = new Pool({ connectionString: url, max: 1 });
  migrationPool.on("connect", (client) => {
    void client.query(`SET search_path TO ${schemaName}`);
  });
  try {
    const migrationDb = drizzle(migrationPool);
    await migrate(migrationDb, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: schemaName,
    });
  } finally {
    await migrationPool.end();
  }

  const database = createDatabase({
    url,
    schema: schemaName,
    pool: { max: 4, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000 },
  });

  return {
    database,
    schemaName,
    adminPool,
    url,
    async end() {
      await database.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    },
  };
}

/** 直接 SQL 断言用：带 schema 前缀的限定表名。 */
export function qualifiedTableName(schemaName: string, table: string): string {
  return `"${schemaName}"."${table}"`;
}

/** 生成合法 6 位邀请码字符（排除 0/O/1/I/L，docs/03 §5.1）。 */
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

export { randomUUID };
