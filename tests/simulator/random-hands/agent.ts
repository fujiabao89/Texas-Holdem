/**
 * 模拟代理动作选择（TEX-16）。
 *
 * 只从 Engine 返回的 `LegalActions` 中选择动作（docs/06-testing-strategy.md §5：
 * 「每次从 Engine LegalActions 中选择动作」），绝不在测试端推断或裁决规则。
 * 随机性全部来自注入的 `SeededRandom`，同一 rng 状态恒选择同一动作。
 *
 * 权威规格：docs/01-engine-spec.md §5.2（LegalActions 语义）；docs/06-testing-strategy.md §5。
 */
import type { LegalActions, PlayerAction, ActionType } from "../../../packages/poker-engine/src/index";
import type { SeededRandom } from "../../support/random";
import type { AgentStyle } from "./scenario";

/** 各风格的动作权重（仅在当前合法动作集合内归一化）。 */
const STYLE_WEIGHTS: Record<AgentStyle, Record<ActionType, number>> = {
  // 全下偏好：制造多人 All-in / Side Pot / 深浅筹码碰撞。
  aggressive: { fold: 6, check: 8, call: 22, bet: 12, raise: 14, "all-in": 38 },
  balanced: { fold: 14, check: 20, call: 26, bet: 14, raise: 14, "all-in": 12 },
  cautious: { fold: 22, check: 30, call: 26, bet: 10, raise: 6, "all-in": 6 },
  // 弃牌偏好：保证「Fold 到底（无人摊牌直接判给剩余者）」覆盖。
  folding: { fold: 55, check: 30, call: 10, bet: 2, raise: 1, "all-in": 2 },
};

/** bet/raise 目标额分位（0=最小，1=全下上限）；aggressive 偏向上限。 */
const AMOUNT_QUANTILE_WEIGHTS: Record<"aggressive" | "others", readonly (readonly [number, number])[]> = {
  aggressive: [
    [0, 1],
    [0.25, 1],
    [0.5, 2],
    [1, 6],
  ],
  others: [
    [0, 3],
    [0.25, 2],
    [0.5, 2],
    [1, 3],
  ],
};

function pickWeighted<T>(rng: SeededRandom, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let cursor = rng.next() * total;
  for (const [value, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

function legalActionTypes(legal: LegalActions): ActionType[] {
  const types: ActionType[] = [];
  if (legal.canFold) types.push("fold");
  if (legal.canCheck) types.push("check");
  if (legal.canCall) types.push("call");
  if (legal.canBet) types.push("bet");
  if (legal.canRaise) types.push("raise");
  if (legal.canAllIn) types.push("all-in");
  return types;
}

/**
 * 为当前行动者选择一个动作。金额语义：`bet`/`raise` 的 `amount` 为本街目标总投入，
 * 恒在 Engine 给出的 `[min, max]` 区间内；其余动作不带金额。
 */
export function chooseAction(
  seatIndex: number,
  legal: LegalActions,
  rng: SeededRandom,
  style: AgentStyle,
): PlayerAction {
  const options = legalActionTypes(legal);
  if (options.length === 0) {
    throw new Error(`chooseAction: Engine LegalActions 未提供任何合法动作（seat ${seatIndex}）`);
  }
  const weights = STYLE_WEIGHTS[style];
  const type = pickWeighted(
    rng,
    options.map((t) => [t, weights[t]!] as const),
  );

  let amount: number | undefined;
  if (type === "bet" && legal.minBetTo !== null) {
    amount = targetAmount(legal.minBetTo, legal.maxRaiseTo, rng, style);
  } else if (type === "raise" && legal.minRaiseTo !== null) {
    amount = targetAmount(legal.minRaiseTo, legal.maxRaiseTo, rng, style);
  }

  return {
    type,
    seatIndex,
    ...(amount !== undefined ? { amount } : {}),
    source: "human_socket",
  };
}

/** 在 [min, max] 内按风格分位取目标总投入；防御性 clamp，永不越界。 */
function targetAmount(min: number, max: number, rng: SeededRandom, style: AgentStyle): number {
  if (max <= min) return min;
  const quantile = pickWeighted(rng, AMOUNT_QUANTILE_WEIGHTS[style === "aggressive" ? "aggressive" : "others"]);
  const raw = min + Math.round(quantile * (max - min));
  return Math.min(max, Math.max(min, raw));
}
