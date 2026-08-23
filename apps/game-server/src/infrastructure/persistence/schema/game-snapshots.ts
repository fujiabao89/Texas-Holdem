import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./bytea";
import { hands } from "./hands";
import { tournaments } from "./tournaments";

/**
 * `game_snapshots`（docs/03-data-model.md §5.7）。
 *
 * 手末完整 GameState 检查点：`state` 含 Deck 顺序、底牌等隐藏信息，
 * 服务器私有；原始行永不直接投递客户端（§6）。
 * 每手至多一个已提交快照，且水位线无歧义（§5.7）。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const gameSnapshots = pgTable(
  "game_snapshots",
  {
    id: uuid("id").primaryKey(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "restrict" }),
    handId: uuid("hand_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    state: jsonb("state").$type<unknown>().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    stateChecksum: bytea("state_checksum").notNull(),
    commitChecksum: bytea("commit_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 快照对应的 Hand 必须属于同一 Tournament（§5.7）。
    foreignKey({
      name: "game_snapshots_hand_fk",
      columns: [t.handId, t.tournamentId],
      foreignColumns: [hands.id, hands.tournamentId],
    }).onDelete("restrict"),
    check("game_snapshots_sequence_check", sql`"sequence" > 0`),
    check("game_snapshots_schema_version_check", sql`"schema_version" > 0`),
    check("game_snapshots_state_checksum_check", sql`octet_length("state_checksum") = 32`),
    check("game_snapshots_commit_checksum_check", sql`octet_length("commit_checksum") = 32`),
    // 每手至多一个已提交手末快照（§5.7）。
    uniqueIndex("game_snapshots_tournament_hand_unique").on(t.tournamentId, t.handId),
    // 恢复水位线无歧义（§5.7）。
    uniqueIndex("game_snapshots_tournament_sequence_unique").on(t.tournamentId, t.sequence),
  ],
);
