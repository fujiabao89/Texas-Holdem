# Database

数据库连接、事务边界与 Drizzle 实例（底层驱动固定为 `pg`，docs/03-data-model.md §5.9/§13 决策 1）。

## 模块

- [config.ts](./config.ts) — `parseDatabaseConfig(env)`：解析 `DATABASE_URL`（必需）、`DATABASE_SCHEMA`（默认 `game`）与连接池参数；schema 名校验为安全小写标识符；敏感值不进错误信息。
- [create-database.ts](./create-database.ts) — `createDatabase(config)`：`pg.Pool` + 每连接 `SET search_path TO <schema>` + `drizzle(pool, { schema })`；`withTransaction(fn)` 提供显式事务边界（Commit Bundle 等原子写入必须走它，不得跨连接拼接）。

## 设计要点

- 表定义不带 schema 前缀：目标 schema 由连接的 `search_path` 决定，同一份迁移/代码可用于生产 `game` 私有 schema 与测试 `tex_test_<runId>` 隔离 schema。
- `bigint` 列一律 `mode: "bigint"`（`last_committed_sequence`、筹码、事件 `sequence`），不在 Node 层丢精度（docs/03 §5.9）。
