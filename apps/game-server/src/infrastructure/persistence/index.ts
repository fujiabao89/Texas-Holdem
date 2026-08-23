/**
 * Persistence 模块公共入口（docs/03-data-model.md）。
 *
 * 供后续 TEX-19～TEX-22 使用的稳定接口：
 * - `createDatabase` / `parseDatabaseConfig`：连接与事务边界；
 * - `schema/*`：Drizzle 表定义（查询/迁移共用）；
 * - `repositories/*`：Room/Tournament 控制面与手末 Commit Bundle 仓储；
 * - `player-token` / `display-name` / `checksum`：凭证摘要与确定性序列化工具。
 *
 * 领域引擎（poker-engine）不得依赖本目录；本模块不裁决牌局结果。
 */
export * from "./database";
export * from "./schema";
export * from "./repositories";
export * from "./player-token";
export * from "./display-name";
export * from "./checksum";
