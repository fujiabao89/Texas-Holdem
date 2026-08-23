/**
 * 数据库连接配置解析（docs/03-data-model.md §3/§5.9）。
 *
 * 目标 schema 通过 `search_path` 注入（生产默认 `game` 私有 schema，
 * 测试使用 `tex_test_<runId>` 隔离 schema），迁移 SQL 与 Drizzle 查询
 * 均不带 schema 前缀，因此同一份代码可用于任意隔离 schema。
 */

export interface DatabasePoolOptions {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export interface DatabaseConfig {
  /** PostgreSQL 连接串（只进环境变量/部署平台注入，不写日志）。 */
  url: string;
  /** 目标 schema 名（已校验为安全标识符）。 */
  schema: string;
  pool: DatabasePoolOptions;
}

export const DEFAULT_DATABASE_SCHEMA = "game";

/** schema 名必须是简单小写标识符，避免拼接 search_path 时的注入面。 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new DatabaseConfigError(
      `database schema name must match ${SCHEMA_NAME_PATTERN.source} (got an invalid name)`,
    );
  }
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DatabaseConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

/** 从环境变量解析数据库配置；敏感值（url）不进入错误信息。 */
export function parseDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const url = env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new DatabaseConfigError("DATABASE_URL is required");
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new DatabaseConfigError("DATABASE_URL must be a postgres:// connection string");
  }

  const schema = env.DATABASE_SCHEMA ?? DEFAULT_DATABASE_SCHEMA;
  assertValidSchemaName(schema);

  return {
    url,
    schema,
    pool: {
      max: parsePositiveInt(env.DATABASE_POOL_MAX, 10, "DATABASE_POOL_MAX"),
      idleTimeoutMillis: parsePositiveInt(
        env.DATABASE_POOL_IDLE_TIMEOUT_MS,
        30_000,
        "DATABASE_POOL_IDLE_TIMEOUT_MS",
      ),
      connectionTimeoutMillis: parsePositiveInt(
        env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        10_000,
        "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      ),
    },
  };
}
