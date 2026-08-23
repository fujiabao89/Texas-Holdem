import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { hands } from "./hands";
import { tournamentPlayers } from "./tournament-players";
import { tournaments } from "./tournaments";
import { aiFallbackReasonEnum, aiRequestStatusEnum } from "./enums";

/**
 * `ai_requests`（docs/03-data-model.md §5.8，P1 启用）。
 *
 * P0 不做 AI 调用，但 Schema 按权威规格落地。
 * 不存 API Key、Prompt/Response/Reasoning 原文；只存结构化用量元数据（§5.8/§6）。
 * CHECK 表达式使用带引号的裸列名：PostgreSQL 表约束不能使用表别名。
 */
export const aiRequests = pgTable(
  "ai_requests",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    tournamentId: uuid("tournament_id")
      .notNull()
      .references(() => tournaments.id, { onDelete: "restrict" }),
    tournamentPlayerId: uuid("tournament_player_id").notNull(),
    handId: uuid("hand_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    status: aiRequestStatusEnum("status").notNull(),
    fallbackReason: aiFallbackReasonEnum("fallback_reason"),
    providerStatusCode: integer("provider_status_code"),
    cost: numeric("cost", { precision: 18, scale: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 发起调用的 BOT 席位必须属于本 Tournament（§5.8）。
    foreignKey({
      name: "ai_requests_tournament_player_fk",
      columns: [t.tournamentId, t.tournamentPlayerId],
      foreignColumns: [tournamentPlayers.tournamentId, tournamentPlayers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_requests_hand_fk",
      columns: [t.handId, t.tournamentId],
      foreignColumns: [hands.id, hands.tournamentId],
    }).onDelete("restrict"),
    // FALLBACK 必须有降级原因；SUCCESS 不得携带（§5.8/§5.9）。
    check(
      "ai_requests_fallback_reason_check",
      sql`("status" = 'FALLBACK') = ("fallback_reason" IS NOT NULL)`,
    ),
    check("ai_requests_latency_ms_check", sql`"latency_ms" >= 0`),
    check("ai_requests_input_tokens_check", sql`"input_tokens" IS NULL OR "input_tokens" >= 0`),
    check(
      "ai_requests_output_tokens_check",
      sql`"output_tokens" IS NULL OR "output_tokens" >= 0`,
    ),
    check("ai_requests_cost_check", sql`"cost" IS NULL OR "cost" >= 0`),
    index("ai_requests_tournament_created_at_idx").on(t.tournamentId, t.createdAt),
  ],
);
