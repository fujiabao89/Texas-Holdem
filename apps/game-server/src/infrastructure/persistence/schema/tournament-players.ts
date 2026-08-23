import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { hands } from "./hands";
import { roomPlayers } from "./room-players";
import { tournaments } from "./tournaments";
import { playerKindEnum, pokerStatusEnum } from "./enums";

/**
 * `tournament_players`（docs/03-data-model.md §5.4）。
 *
 * - `(tournament_id, room_id)` → `tournaments(id, room_id)`：禁止跨 Tournament 乱挂；
 * - `(room_id, player_id)` → `room_players(room_id, id)`：禁止跨 Room 引用玩家；
 * - `(eliminated_hand_id, tournament_id)` → `hands(id, tournament_id)`：淘汰必须发生在
 *   本 Tournament 的某一手。
 * 凭证摘要只在 room_players，不复制到参赛记录；ConnectionStatus 不落库（§5.4）。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const tournamentPlayers = pgTable(
  "tournament_players",
  {
    id: uuid("id").primaryKey(),
    tournamentId: uuid("tournament_id").notNull(),
    roomId: uuid("room_id").notNull(),
    playerId: uuid("player_id").notNull(),
    displayName: text("display_name").notNull(),
    seatIndex: smallint("seat_index").notNull(),
    kind: playerKindEnum("kind").notNull(),
    startingStack: bigint("starting_stack", { mode: "bigint" }).notNull(),
    finalStack: bigint("final_stack", { mode: "bigint" }),
    forfeitedChips: bigint("forfeited_chips", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    pokerStatus: pokerStatusEnum("poker_status").notNull(),
    rank: integer("rank"),
    eliminatedHandId: uuid("eliminated_hand_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "tournament_players_tournament_fk",
      columns: [t.tournamentId, t.roomId],
      foreignColumns: [tournaments.id, tournaments.roomId],
    }).onDelete("restrict"),
    foreignKey({
      name: "tournament_players_player_fk",
      columns: [t.roomId, t.playerId],
      foreignColumns: [roomPlayers.roomId, roomPlayers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "tournament_players_eliminated_hand_fk",
      columns: [t.eliminatedHandId, t.tournamentId],
      foreignColumns: [hands.id, hands.tournamentId],
    }).onDelete("restrict"),
    check("tournament_players_seat_index_check", sql`"seat_index" BETWEEN 0 AND 9`),
    check("tournament_players_starting_stack_check", sql`"starting_stack" > 0`),
    check(
      "tournament_players_final_stack_check",
      sql`"final_stack" IS NULL OR "final_stack" >= 0`,
    ),
    check("tournament_players_forfeited_chips_check", sql`"forfeited_chips" >= 0`),
    check("tournament_players_rank_check", sql`"rank" IS NULL OR "rank" > 0`),
    uniqueIndex("tournament_players_tournament_player_unique").on(t.tournamentId, t.playerId),
    uniqueIndex("tournament_players_tournament_seat_unique").on(t.tournamentId, t.seatIndex),
    // 同 Tournament 名次唯一（rank 非空时，§5.4）。
    uniqueIndex("tournament_players_tournament_rank_unique")
      .on(t.tournamentId, t.rank)
      .where(sql`rank IS NOT NULL`),
    // 供 tournaments.champion / ai_requests 复合外键引用（§5.9）。
    uniqueIndex("tournament_players_tournament_id_unique").on(t.tournamentId, t.id),
    index("tournament_players_tournament_idx").on(t.tournamentId),
  ],
);
