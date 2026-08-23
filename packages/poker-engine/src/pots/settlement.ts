/**
 * 底池结算（TEX-14）。
 *
 * 每个 Pot 独立在 `eligiblePlayers` 间用 `evaluateHand([hole×2, ...board×5])`（7 张）+ `compareEvaluations`
 * 取最强；平局 Split。Odd Chip：余数从 Dealer 左侧开始顺时针，分别给**该 Pot 第一个符合获奖资格**的赢家
 * （跳过 dealer、可绕桌；每 Pot 独立计数）。复用 `cards/` 的评估器，勿重写。
 *
 * 权威规格：docs/01-engine-spec.md §9、§10、§11。
 */
import { evaluateHand, compareEvaluations } from "../cards";
import type { Card } from "../cards";
import type { HandEvaluation } from "../cards";
import type { Pot, PotAward } from "../model/pot";

export interface SettlePlayer {
  readonly seatIndex: number;
  readonly holeCards: readonly Card[];
  readonly folded: boolean;
}

/** 逐 Pot 独立结算，返回每个 Pot 的分配结果。`board` 必须为 5 张（比牌/自动补牌后）。 */
export function settlePots(
  pots: readonly Pot[],
  players: readonly SettlePlayer[],
  board: readonly Card[],
  dealerSeat: number,
): PotAward[] {
  const bySeat = new Map<number, SettlePlayer>();
  for (const p of players) bySeat.set(p.seatIndex, p);
  return pots.map((pot) => settleOne(pot, bySeat, board, dealerSeat));
}

function settleOne(
  pot: Pot,
  bySeat: Map<number, SettlePlayer>,
  board: readonly Card[],
  dealerSeat: number,
): PotAward {
  const eligible = pot.eligiblePlayers
    .map((seat) => bySeat.get(seat))
    .filter((p): p is SettlePlayer => p !== undefined && !p.folded && p.holeCards.length === 2);

  // 每位合格者评估 7 张最佳 5。
  const evaluated: { seat: number; ev: HandEvaluation }[] = eligible.map((p) => ({
    seat: p.seatIndex,
    ev: evaluateHand([...p.holeCards, ...board]),
  }));

  let bestEv = evaluated[0]!.ev;
  for (const e of evaluated) {
    if (compareEvaluations(e.ev, bestEv) > 0) bestEv = e.ev;
  }
  const winners = evaluated.filter((e) => compareEvaluations(e.ev, bestEv) === 0).map((e) => e.seat);

  // 平局平分；余数从 Dealer 左侧顺时针给第一个 `remainder` 个赢家。
  const total = pot.amount;
  const base = Math.floor(total / winners.length);
  const remainder = total % winners.length;
  const orderedWinners = orderClockwiseFromDealer(winners, dealerSeat);

  const prizeBySeat: Record<number, number> = {};
  for (let i = 0; i < orderedWinners.length; i++) {
    prizeBySeat[orderedWinners[i]!] = base + (i < remainder ? 1 : 0);
  }

  return {
    potIndex: pot.index,
    totalAmount: total,
    winners: Object.freeze([...orderedWinners]),
    prizeBySeat: Object.freeze(prizeBySeat),
    eligiblePlayers: Object.freeze([...pot.eligiblePlayers]),
  };
}

/** 把一组座位号按「Dealer 左侧起顺时针」排序（可绕桌；跳过 dealer）。 */
function orderClockwiseFromDealer(seatIndices: readonly number[], dealerSeat: number): number[] {
  const sorted = [...seatIndices].sort((a, b) => a - b);
  // 找到第一个 > dealerSeat 的位置作为起点；若无，从最小座位开始（绕桌）。
  const startIdx = sorted.findIndex((s) => s > dealerSeat);
  const start = startIdx === -1 ? 0 : startIdx;
  const ordered: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    ordered.push(sorted[(start + i) % sorted.length]!);
  }
  return ordered;
}
