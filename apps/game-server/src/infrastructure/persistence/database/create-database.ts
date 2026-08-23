import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "../schema";
import { assertValidSchemaName, type DatabaseConfig } from "./config";

/**
 * 数据库连接与事务边界（docs/03-data-model.md §3/§5.9/§7）。
 *
 * - 底层驱动固定为 `pg`；Drizzle 只做类型化查询与显式事务（§13 决策 1）。
 * - 每个新连接执行 `SET search_path TO <schema>`：迁移 SQL 与 Drizzle 查询
 *   均不带 schema 前缀，目标 schema 由连接决定。
 * - Commit Bundle 等原子写入必须走 `withTransaction`，同一事务（连接）内
 *   完成全部语句，不得跨连接拼接（§7.3）。
 */
export type GameDatabase = NodePgDatabase<typeof schema>;
export type GameTransaction = Parameters<Parameters<GameDatabase["transaction"]>[0]>[0];
export type Database = {
  readonly pool: Pool;
  readonly db: GameDatabase;
  /** 显式事务边界：fn 内任一语句失败即整体回滚。 */
  withTransaction<T>(fn: (tx: GameTransaction) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

export function createDatabase(config: DatabaseConfig): Database {
  assertValidSchemaName(config.schema);
  const pool = new Pool({
    connectionString: config.url,
    max: config.pool.max,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
  });
  // 新连接建立时先设置 search_path，再被业务查询使用（同连接内按调用顺序执行）。
  pool.on("connect", (client: PoolClient) => {
    void client.query(`SET search_path TO ${config.schema}`);
  });

  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    withTransaction(fn) {
      return db.transaction(fn);
    },
    end() {
      return pool.end();
    },
  };
}
