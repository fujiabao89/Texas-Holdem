import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 持久化枚举（docs/03-data-model.md §5）。
 *
 * 枚举值一经迁移落库即视为兼容性契约：新增值需要新迁移，
 * 不得复用或改写既有值的语义。
 */

/** `rooms.mode`（§5.1）：P0 只启用 MULTIPLAYER；SINGLE_PLAYER 为 P1 单人模式预留。 */
export const roomModeEnum = pgEnum("room_mode", ["MULTIPLAYER", "SINGLE_PLAYER"]);

/** `rooms.status`（§5.1）：CREATED → LOBBY → IN_GAME → FINISHED → LOBBY；可转 CLOSED。 */
export const roomStatusEnum = pgEnum("room_status", [
  "CREATED",
  "LOBBY",
  "IN_GAME",
  "FINISHED",
  "CLOSED",
]);

/** `room_players.kind` / `tournament_players.kind`（§5.2/§5.4）。 */
export const playerKindEnum = pgEnum("player_kind", ["HUMAN", "BOT"]);

/** `room_players.status`（§5.2）：LEFT 保留历史引用，禁止旧凭证重连。 */
export const roomPlayerStatusEnum = pgEnum("room_player_status", ["ACTIVE", "LEFT"]);

/** `room_players.left_reason`（§5.2）。 */
export const leftReasonEnum = pgEnum("room_player_left_reason", [
  "USER_LEFT",
  "DISCONNECT_TIMEOUT",
  "ROOM_CLOSED",
]);

/** `tournaments.status`（§5.3）。 */
export const tournamentStatusEnum = pgEnum("tournament_status", [
  "IN_GAME",
  "FINISHED",
  "ABANDONED_NO_HUMAN",
]);

/** `tournament_players.poker_status`（§5.4）。 */
export const pokerStatusEnum = pgEnum("poker_status", ["ACTIVE", "ELIMINATED", "WITHDRAWN"]);

/** `hands.end_reason`（§5.5）。 */
export const handEndReasonEnum = pgEnum("hand_end_reason", [
  "ALL_FOLDED",
  "SHOWDOWN",
  "ABANDONED",
]);

/** `ai_requests.status`（§5.8，P1 启用）。 */
export const aiRequestStatusEnum = pgEnum("ai_request_status", ["SUCCESS", "FALLBACK"]);

/** `ai_requests.fallback_reason`（§5.8，P1 启用）。 */
export const aiFallbackReasonEnum = pgEnum("ai_fallback_reason", [
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_JSON",
  "ILLEGAL_ACTION",
  "PROVIDER_ERROR",
]);
