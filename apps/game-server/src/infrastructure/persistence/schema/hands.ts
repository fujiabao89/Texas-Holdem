import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tournaments } from "./tournaments";
import { handEndReasonEnum } from "./enums";

/**
 * `hands`（docs/03-data-model.md §5.5）。
 *
 * 隐藏信息（Burn 牌面、未公开底牌）不入此表，只存在于
 * `hand_events.payload` 与 `game_snapshots.state`（服务器私有）。
 * `UNIQUE(id, tournament_id)` 供 hand_events / game_snapshots /
 * tournament_players.eliminated_hand_id 的复合外键引用。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const hands = pgTable(
  "hands",
  {
    id: uuid("id").primaryKey(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "restrict" }),
    handNumber: integer("hand_number").notNull(),
    dealerSeat: smallint("dealer_seat").notNull(),
    sbSeat: smallint("sb_seat").notNull(),
    bbSeat: smallint("bb_seat").notNull(),
    blindLevelIndex: integer("blind_level_index").notNull(),
    smallBlind: bigint("small_blind", { mode: "bigint" }).notNull(),
    bigBlind: bigint("big_blind", { mode: "bigint" }).notNull(),
    communityCards: jsonb("community_cards").$type<unknown>().notNull(),
    summary: jsonb("summary").$type<unknown>().notNull(),
    endReason: handEndReasonEnum("end_reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("hands_hand_number_check", sql`"hand_number" > 0`),
    check("hands_dealer_seat_check", sql`"dealer_seat" BETWEEN 0 AND 9`),
    check("hands_sb_seat_check", sql`"sb_seat" BETWEEN 0 AND 9`),
    check("hands_bb_seat_check", sql`"bb_seat" BETWEEN 0 AND 9`),
    check("hands_blind_level_index_check", sql`"blind_level_index" >= 0`),
    check(
      "hands_blinds_check",
      sql`"small_blind" > 0 AND "big_blind" > "small_blind"`,
    ),
    // 公共牌是 0–5 张的 JSON 数组；未到 River 结束不人工补牌（§5.5）。
    check(
      "hands_community_cards_check",
      sql`jsonb_typeof("community_cards") = 'array' AND jsonb_array_length("community_cards") BETWEEN 0 AND 5`,
    ),
    uniqueIndex("hands_tournament_hand_number_unique").on(t.tournamentId, t.handNumber),
    uniqueIndex("hands_id_tournament_id_unique").on(t.id, t.tournamentId),
    index("hands_tournament_hand_number_desc_idx").on(t.tournamentId, t.handNumber.desc()),
  ],
);
