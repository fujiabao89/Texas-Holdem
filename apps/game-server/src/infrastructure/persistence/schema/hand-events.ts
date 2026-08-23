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
import { hands } from "./hands";
import { tournaments } from "./tournaments";

/**
 * `hand_events`（docs/03-data-model.md §5.6）。
 *
 * 完整结构化事件流（含 Burn 牌面、DEAL_HOLE_CARD 实际牌面等诊断级隐藏信息）
 * —— 服务器私有，任何对外读取必须走投影（§6）。
 * `id` 使用 bigint identity；事件量大，按 §5.6 设计意图允许实现自选。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const handEvents = pgTable(
  "hand_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "restrict" }),
    handId: uuid("hand_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    handSequence: integer("hand_sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 事件归属手必须属于同一 Tournament（§5.6）。
    foreignKey({
      name: "hand_events_hand_fk",
      columns: [t.handId, t.tournamentId],
      foreignColumns: [hands.id, hands.tournamentId],
    }).onDelete("restrict"),
    // Tournament 作用域的 Event Stream：从 1 开始跨 Hand 严格递增（§5.6）。
    check("hand_events_sequence_check", sql`"sequence" > 0`),
    check("hand_events_hand_sequence_check", sql`"hand_sequence" > 0`),
    check("hand_events_schema_version_check", sql`"schema_version" > 0`),
    uniqueIndex("hand_events_tournament_sequence_unique").on(t.tournamentId, t.sequence),
    // 本手内 1..N 连续，用于验证整手事件无缺口（§5.6）。
    uniqueIndex("hand_events_hand_hand_sequence_unique").on(t.handId, t.handSequence),
  ],
);
