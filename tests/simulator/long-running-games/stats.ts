/**
 * 覆盖统计（TEX-16）。
 *
 * 按 docs/06-testing-strategy.md §5【覆盖反馈】聚合分布：玩家数、牌局阶段、动作类型、
 * 牌型、Pot 数量、All-in 人数、Heads-Up、盲注变更与结束原因。分层运行（Smoke/Nightly/RC）
 * 结束时若「必需类别」某类为零，视为生成器覆盖失败（退出码非 0）。
 */
import type { ActionType, Street } from "../../../packages/poker-engine/src/index";
import type { SimulatorScenario, AgentStyle, StackDepth } from "../random-hands/scenario";

/** 一手牌的结算摘要（由 runner 从 `hand.outcome` 与手状态提取）。 */
export interface HandRecord {
  readonly handNumber: number;
  /** 手开始时的玩家数（含本手参赛者）。 */
  readonly playersAtStart: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** 上一手的盲注（首手为 null，用于判定盲注上升/下降）。 */
  readonly previousBlinds: { readonly sb: number; readonly bb: number } | null;
  /** 本手到达的街（按最终公共牌张数判定）。 */
  readonly streets: readonly Street[];
  /** 是否走到摊牌（false = 其余玩家均弃牌直接判给剩余者）。 */
  readonly showdown: boolean;
  readonly potCount: number;
  /** 本手全下玩家数。 */
  readonly allInPlayers: number;
  /** 本手 Short All-in 动作数（Short Call §8.4 / Short Raise、低于 BB 开注 §8.3）。 */
  readonly shortAllInCount: number;
  readonly actionCounts: Partial<Record<ActionType, number>>;
  /** 摊牌赢家（含平分）的牌型名；非摊牌手为空。 */
  readonly winnerHandRanks: readonly string[];
  readonly stackDepth: StackDepth;
  readonly agentStyle: AgentStyle;
}

/** 一场锦标赛的完整记录。 */
export interface TournamentRecord {
  readonly seed: number;
  readonly scenario: SimulatorScenario;
  readonly hands: readonly HandRecord[];
  readonly actionsTaken: number;
  readonly champion: number | null;
  /** 是否到达过 Heads-Up（任一手以 2 名 ACTIVE 玩家开始）。 */
  readonly headsUpReached: boolean;
}

/** 分层运行必须非零的覆盖类别（docs/06-testing-strategy.md §5 加权覆盖要求）。 */
export const TIER_REQUIRED_CATEGORIES: readonly string[] = [
  "players-2",
  "players-3",
  "players-10",
  "stack-shallow",
  "stack-deep",
  "blind-mode-fixed",
  "blind-mode-hands",
  "blind-mode-time",
  "blind-increase",
  "blind-decrease",
  "street-flop",
  "street-turn",
  "street-river",
  "hand-showdown",
  "hand-fold-end",
  "pot-side",
  "allin-multi",
  "allin-short",
  "heads-up-reached",
  "action-fold",
  "action-check",
  "action-call",
  "action-bet",
  "action-raise",
  "action-all-in",
];

function bump(counters: Map<string, number>, key: string, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export class CoverageStats {
  private readonly counters = new Map<string, number>();

  /** 摊牌赢家的牌型分布（`rank-<name>`）。 */
  recordTournament(rec: TournamentRecord): void {
    bump(this.counters, "tournament-complete");
    const playerKey =
      rec.scenario.playerCount === 2 || rec.scenario.playerCount === 3 || rec.scenario.playerCount === 10
        ? `players-${rec.scenario.playerCount}`
        : "players-4to9";
    bump(this.counters, playerKey);
    bump(this.counters, `stack-${rec.scenario.stackDepth}`);
    bump(this.counters, `blind-mode-${rec.scenario.blindMode}`);
    bump(this.counters, `agent-style-${rec.scenario.agentStyle}`);
    if (rec.headsUpReached) bump(this.counters, "heads-up-reached");

    for (const hand of rec.hands) {
      bump(this.counters, "hands-total");
      for (const street of hand.streets) bump(this.counters, `street-${street}`);
      if (hand.showdown) {
        bump(this.counters, "hand-showdown");
        for (const rank of hand.winnerHandRanks) bump(this.counters, `rank-${rank}`);
      } else {
        bump(this.counters, "hand-fold-end");
      }
      bump(this.counters, hand.potCount >= 2 ? "pot-side" : "pot-single");
      if (hand.allInPlayers >= 2) {
        bump(this.counters, "allin-multi");
      } else if (hand.allInPlayers === 1) {
        bump(this.counters, "allin-single");
      }
      if (hand.shortAllInCount > 0) {
        bump(this.counters, "allin-short", hand.shortAllInCount);
      }
      if (hand.previousBlinds) {
        if (hand.bigBlind > hand.previousBlinds.bb || hand.smallBlind > hand.previousBlinds.sb) {
          bump(this.counters, "blind-increase");
        }
        if (hand.bigBlind < hand.previousBlinds.bb || hand.smallBlind < hand.previousBlinds.sb) {
          bump(this.counters, "blind-decrease");
        }
      }
      for (const [type, count] of Object.entries(hand.actionCounts)) {
        if (count) bump(this.counters, `action-${type}`, count);
      }
    }
  }

  get(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** 排序后的聚合视图（成功运行只保存聚合统计，docs/06 §5）。 */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.counters.keys()].sort()) {
      out[key] = this.counters.get(key)!;
    }
    return out;
  }

  /** 分层运行结束后仍未命中的必需类别；非空即生成器覆盖失败。 */
  missingCategories(required: readonly string[] = TIER_REQUIRED_CATEGORIES): string[] {
    return required.filter((key) => (this.counters.get(key) ?? 0) === 0);
  }
}
