/**
 * Engine 不变量自动断言（TEX-14）。
 *
 * 在起手初始化后、每个合法动作后、每手结算后调用（§4）。任一不变量被违反即抛错（运行时按 §16 Critical
 * Engine Error 冻结）。覆盖：筹码守恒、卡牌唯一、52 张无重叠分区、筹码非负、Pot 非负、唯一 currentActor、
 * Fold 不可获奖、每池 ≥2 contributor 且 ≥1 eligible。
 *
 * 权威规格：docs/01-engine-spec.md §17、§4。
 */
import { cardKey } from "../cards";
import type { GameState } from "../model/hand";

/** 校验全部不变量；违反即抛错。 */
export function assertInvariants(state: GameState): void {
  assertChipsNonNegative(state);
  assertPotsNonNegative(state);
  assertUniqueActor(state);
  assertCardsUniqueAndConserved(state);
  assertFoldNotWinnable(state);
  assertPotSettleable(state);
  assertChipConservation(state);
}

function assertChipsNonNegative(state: GameState): void {
  for (const seat of state.seats) {
    if (!Number.isInteger(seat.chips) || seat.chips < 0) {
      throw new Error(`不变量违反: 座位 ${seat.seatIndex} 筹码非法 ${seat.chips}`);
    }
    if (seat.handContribution < 0 || seat.streetBet < 0) {
      throw new Error(`不变量违反: 座位 ${seat.seatIndex} 贡献/本街投入非法`);
    }
  }
}

function assertPotsNonNegative(state: GameState): void {
  for (const pot of state.pots) {
    if (!Number.isInteger(pot.amount) || pot.amount < 0) {
      throw new Error(`不变量违反: Pot ${pot.index} 金额非法 ${pot.amount}`);
    }
  }
}

function assertUniqueActor(state: GameState): void {
  if (state.currentActor !== null) {
    const seat = state.seats.find((s) => s.seatIndex === state.currentActor);
    if (!seat || seat.folded || seat.isAllIn) {
      throw new Error(`不变量违反: currentActor ${state.currentActor} 不可行动`);
    }
  }
}

function assertCardsUniqueAndConserved(state: GameState): void {
  const all: string[] = [];
  let hole = 0;
  for (const s of state.seats) {
    for (const c of s.holeCards) {
      all.push(cardKey(c));
      hole++;
    }
  }
  for (const c of state.communityCards) all.push(cardKey(c));
  for (const c of state.burnCards) all.push(cardKey(c));
  for (const c of state.remainingDeck) all.push(cardKey(c));
  if (new Set(all).size !== all.length) {
    throw new Error("不变量违反: 出现重复牌");
  }
  const total = hole + state.communityCards.length + state.burnCards.length + state.remainingDeck.length;
  if (total !== 52) {
    throw new Error(`不变量违反: 牌堆分区和 ${total} != 52`);
  }
}

function assertFoldNotWinnable(state: GameState): void {
  for (const pot of state.pots) {
    for (const seat of pot.eligiblePlayers) {
      const p = state.seats.find((s) => s.seatIndex === seat);
      if (p?.folded) {
        throw new Error(`不变量违反: Pot ${pot.index} 的 eligible ${seat} 已弃牌`);
      }
    }
  }
}

function assertPotSettleable(state: GameState): void {
  for (const pot of state.pots) {
    if (pot.contributors.length < 2) {
      throw new Error(`不变量违反: Pot ${pot.index} 贡献者不足 ${pot.contributors.length} < 2`);
    }
    if (pot.eligiblePlayers.length < 1) {
      throw new Error(`不变量违反: Pot ${pot.index} 无合格赢家`);
    }
  }
}

function assertChipConservation(state: GameState): void {
  if (state.phase === "hand_end") {
    const sum = state.seats.reduce((acc, s) => acc + s.chips, 0);
    if (sum !== state.initialTotalChips) {
      throw new Error(`不变量违反: 结算后筹码守恒失败 sum=${sum} init=${state.initialTotalChips}`);
    }
  } else {
    const inFlight = state.seats.reduce((acc, s) => acc + s.handContribution, 0);
    const sum = state.seats.reduce((acc, s) => acc + s.chips, 0);
    if (sum + inFlight !== state.initialTotalChips) {
      throw new Error(`不变量违反: 下注中筹码守恒失败 chips=${sum} inflight=${inFlight} init=${state.initialTotalChips}`);
    }
  }
}
