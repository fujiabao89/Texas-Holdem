/**
 * Drizzle Schema 汇总导出（docs/03-data-model.md §5）。
 *
 * 表定义不携带 schema 前缀：目标 schema 由连接的 `search_path` 决定
 * （生产默认 `game`，测试 `tex_test_<runId>`），使同一份迁移 SQL
 * 可以在任何隔离 schema 中执行。
 */
export * from "./enums";
export * from "./bytea";
export * from "./rooms";
export * from "./room-players";
export * from "./tournaments";
export * from "./hands";
export * from "./tournament-players";
export * from "./hand-events";
export * from "./game-snapshots";
export * from "./ai-requests";
