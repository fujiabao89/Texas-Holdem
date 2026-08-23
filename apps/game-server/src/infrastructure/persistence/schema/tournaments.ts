import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { tournamentStatusEnum } from "./enums";

/**
 * `tournaments`（docs/03-data-model.md §5.3）。
 *
 * 注意：`champion_tournament_player_id` → `tournament_players(tournament_id, id)`
 * 的 DEFERRABLE 复合外键是循环依赖，由手写迁移 `0001` 追加，
 * 本表 Drizzle 定义中不含该外键。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const tournaments = pgTable(
  "tournaments",
  {
    id: uuid("id").primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "restrict" }),
    tournamentNo: integer("tournament_no").notNull(),
    status: tournamentStatusEnum("status").notNull(),
    configJson: jsonb("config_json").$type<unknown>().notNull(),
    championTournamentPlayerId: uuid("champion_tournament_player_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    lastCommittedSequence: bigint("last_committed_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    // IN_GAME 与终态字段互斥；终态必须同时具备 finished_at 与保留期（§5.3/§5.9）。
    check(
      "tournaments_finished_at_check",
      sql`("status" = 'IN_GAME') = ("finished_at" IS NULL)`,
    ),
    check(
      "tournaments_retention_check",
      sql`(("status" = 'IN_GAME') = ("retention_expires_at" IS NULL)) AND ("retention_expires_at" IS NULL OR "finished_at" IS NULL OR "retention_expires_at" >= "finished_at")`,
    ),
    check(
      "tournaments_last_committed_sequence_check",
      sql`"last_committed_sequence" >= 0`,
    ),
    // 只有 FINISHED 才允许冠军；ABANDONED_NO_HUMAN 不宣告冠军（§5.3）。
    check(
      "tournaments_champion_check",
      sql`"champion_tournament_player_id" IS NULL OR "status" = 'FINISHED'`,
    ),
    uniqueIndex("tournaments_room_tournament_no_unique").on(t.roomId, t.tournamentNo),
    // 供 tournament_players 复合外键引用（§5.9）。
    uniqueIndex("tournaments_id_room_id_unique").on(t.id, t.roomId),
    index("tournaments_retention_expires_at_idx")
      .on(t.retentionExpiresAt)
      .where(sql`retention_expires_at IS NOT NULL`),
  ],
);
