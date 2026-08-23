import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { roomModeEnum, roomStatusEnum } from "./enums";

/**
 * `rooms`（docs/03-data-model.md §5.1）。
 *
 * 注意：`host_player_id` → `room_players(room_id, id)` 的 DEFERRABLE 复合外键
 * 是循环依赖（room_players.room_id → rooms.id），Drizzle 无法表达，
 * 由手写迁移 `0001` 以 `ALTER TABLE ... DEFERRABLE INITIALLY DEFERRED` 追加，
 * 因此本表 Drizzle 定义中不含该外键（见 migrations/README.md）。
 *
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey(),
    mode: roomModeEnum("mode").notNull(),
    inviteCode: text("invite_code"),
    status: roomStatusEnum("status").notNull(),
    configJson: jsonb("config_json").$type<unknown>().notNull(),
    hostPlayerId: uuid("host_player_id"),
    closedReason: text("closed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
  },
  (t) => [
    // 邀请码：当前有效 MULTIPLAYER 房间内唯一（CLOSED 后失效可复用）；
    // 字符集排除 0/O/1/I/L 等易混淆字符，长度恰为 6（§5.1）。
    check(
      "rooms_invite_code_check",
      sql`("mode" = 'MULTIPLAYER' AND "invite_code" ~ '^[A-HJKMNPQRSTUVWXYZ2-9]{6}$') OR ("mode" = 'SINGLE_PLAYER' AND "invite_code" IS NULL)`,
    ),
    // CLOSED 状态与终止时间/原因码/保留期必须一致出现（§5.1/§5.9）。
    check(
      "rooms_closed_at_check",
      sql`("status" = 'CLOSED') = ("closed_at" IS NOT NULL)`,
    ),
    check(
      "rooms_closed_reason_check",
      sql`"status" <> 'CLOSED' OR "closed_reason" IS NOT NULL`,
    ),
    check(
      "rooms_retention_check",
      sql`(("status" = 'CLOSED') = ("retention_expires_at" IS NOT NULL)) AND ("retention_expires_at" IS NULL OR "closed_at" IS NULL OR "retention_expires_at" >= "closed_at")`,
    ),
    uniqueIndex("rooms_invite_code_active_unique")
      .on(t.inviteCode)
      .where(sql`status <> 'CLOSED' AND mode = 'MULTIPLAYER'`),
    index("rooms_retention_expires_at_idx")
      .on(t.retentionExpiresAt)
      .where(sql`retention_expires_at IS NOT NULL`),
  ],
);
