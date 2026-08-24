/**
 * 锦标赛不变量自动断言（TEX-15）。
 *
 * 在锦标赛开局后、每个合法指令/动作后、每手结算后调用（§17）。任一违反即抛错。
 * 覆盖：筹码守恒（在场筹码 + 未结算 Pot + forfeitedChips = 初始总筹码，§13）、非负筹码、
 * 淘汰/撤回不可行动（§17）、唯一冠军、ACTIVE 手间筹码为正。
 *
 * 权威规格：docs/01-engine-spec.md §13、§17。
 */
import type { TournamentState } from "../model/tournament";

/** 校验全部锦标赛不变量；违反即抛错。 */
export function assertTournamentInvariants(state: TournamentState): void {
  assertChipsNonNegative(state);
  assertForfeitedNonNegative(state);
  assertConservation(state);
  assertTerminalNotActive(state);
  assertActiveChipsBetweenHands(state);
  assertUniqueChampion(state);
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function inPlayChips(state: TournamentState): number {
  const hand = state.hand;
  // 手进行中（含各街下注）时以手级权威状态为准：在场筹码 + 未结算 Pot（各玩家 handContribution）。
  if (hand && hand.phase !== "hand_end") {
    return sum(hand.seats.map((s) => s.chips + s.handContribution));
  }
  // 手已结算或无手：以参赛者当前 chips 为准（ELIMINATED/WITHDRAWN 为 0，已计入 forfeited）。
  return sum(state.participants.map((p) => p.chips));
}

function assertChipsNonNegative(state: TournamentState): void {
  for (const p of state.participants) {
    if (!Number.isInteger(p.chips) || p.chips < 0) {
      throw new Error(`锦标赛不变量违反: 玩家 ${p.seatIndex} 筹码非法 ${p.chips}`);
    }
  }
}

function assertForfeitedNonNegative(state: TournamentState): void {
  if (!Number.isInteger(state.forfeitedChips) || state.forfeitedChips < 0) {
    throw new Error(`锦标赛不变量违反: forfeitedChips 非法 ${state.forfeitedChips}`);
  }
}

function assertConservation(state: TournamentState): void {
  const expected = state.initialTotalChips;
  const actual = inPlayChips(state) + state.forfeitedChips;
  if (actual !== expected) {
    throw new Error(
      `锦标赛不变量违反: 筹码守恒失败 在场+未结算Pot+forfeited=${actual} 初始=${expected}`,
    );
  }
}

function assertTerminalNotActive(state: TournamentState): void {
  // 仅在「进行中的下注手」校验手内座位不得为终态；已结算手是历史记录，允许出现 ELIMINATED/WITHDRAWN。
  const hand = state.hand;
  if (state.handInProgress && hand && hand.phase !== "hand_end") {
    for (const seat of hand.seats) {
      const p = state.participants.find((pp) => pp.seatIndex === seat.seatIndex);
      if (!p || (p.status !== "ACTIVE" && p.status !== "EXIT_PENDING")) {
        throw new Error(`锦标赛不变量违反: 手内座位 ${seat.seatIndex} 状态 ${p?.status} 不可行动`);
      }
    }
  }
  for (const p of state.participants) {
    if ((p.status === "WITHDRAWN" || p.status === "ELIMINATED") && p.chips !== 0) {
      throw new Error(`锦标赛不变量违反: 终态玩家 ${p.seatIndex} 仍有筹码 ${p.chips}`);
    }
  }
}

function assertActiveChipsBetweenHands(state: TournamentState): void {
  if (state.phase === "finished") return;
  if (state.handInProgress) return;
  const hand = state.hand;
  // 手已结算或在手之间，且非完结：ACTIVE 玩家应持有正筹码（否则应已被淘汰/撤回）。
  if (hand && hand.phase !== "hand_end") return;
  for (const p of state.participants) {
    if (p.status === "ACTIVE" && p.chips <= 0) {
      throw new Error(`锦标赛不变量违反: 手间 ACTIVE 玩家 ${p.seatIndex} 筹码 ${p.chips} 非正`);
    }
  }
}

function assertUniqueChampion(state: TournamentState): void {
  if (state.phase !== "finished") return;
  const active = state.participants.filter((p) => p.status === "ACTIVE").length;
  if (active > 1) {
    throw new Error(`锦标赛不变量违反: 已完结仍有多于一位 ACTIVE（${active}）`);
  }
  if (state.champion === null && active === 1) {
    throw new Error("锦标赛不变量违反: 存在唯一 ACTIVE 但无 champion");
  }
}
