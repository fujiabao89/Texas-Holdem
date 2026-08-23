import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { bytea } from "./bytea";
import { leftReasonEnum, playerKindEnum, roomPlayerStatusEnum } from "./enums";

/**
 * `room_players`（docs/03-data-model.md §5.2）。
 *
 * Room 级身份与成员关系表：`UNIQUE(room_id, id)` 供 `rooms.host_player_id`
 * 的 DEFERRABLE 复合外键引用（该外键在手写迁移 0001 中定义）。
 * 连接/在线状态只在内存，本表不是 Presence 系统（§5.2）。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const roomPlayers = pgTable(
  "room_players",
  {
    id: uuid("id").primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull(),
    kind: playerKindEnum("kind").notNull(),
    tokenDigest: bytea("token_digest"),
    tokenKeyId: text("token_key_id"),
    status: roomPlayerStatusEnum("status").notNull(),
    leftReason: leftReasonEnum("left_reason"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [
    // HUMAN 必须持有 HMAC 摘要与密钥版本；BOT 永远没有凭证（§5.2）。
    check(
      "room_players_token_check",
      sql`("kind" = 'HUMAN' AND "token_digest" IS NOT NULL AND "token_key_id" IS NOT NULL) OR ("kind" = 'BOT' AND "token_digest" IS NULL AND "token_key_id" IS NULL)`,
    ),
    check(
      "room_players_token_digest_length_check",
      sql`"token_digest" IS NULL OR octet_length("token_digest") = 32`,
    ),
    // LEFT 与 left_at/left_reason 必须一致出现；ACTIVE 时两者皆空（§5.2/§5.9）。
    check(
      "room_players_left_at_check",
      sql`("status" = 'LEFT') = ("left_at" IS NOT NULL)`,
    ),
    check(
      "room_players_left_reason_check",
      sql`("status" = 'LEFT') = ("left_reason" IS NOT NULL)`,
    ),
    uniqueIndex("room_players_room_id_id_unique").on(t.roomId, t.id),
    uniqueIndex("room_players_display_name_key_unique").on(t.roomId, t.displayNameKey),
    index("room_players_room_status_joined_idx").on(t.roomId, t.status, t.joinedAt, t.id),
  ],
);
