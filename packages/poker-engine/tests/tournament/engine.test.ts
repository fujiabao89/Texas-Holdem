import { describe, it, expect } from "vitest";
import {
  TournamentEngine,
  SeededRandomSource,
  createStandardDeck,
  parseCard,
  cardCode,
  cardKey,
} from "../../src";
import type { Deck, TournamentConfigInput } from "../../src";
import type { TournamentParticipantConfig } from "../../src";

function seat(i: number): TournamentParticipantConfig {
  return { seatIndex: i, name: `P${i}`, kind: "human" };
}

function fixedCfg(over: Partial<TournamentConfigInput> = {}): TournamentConfigInput {
  return {
    maxPlayers: 6,
    startingStack: 100,
    smallBlind: 10,
    bigBlind: 20,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
    actionTime: 30,
    timeBank: 60,
    ...over,
  };
}

function makeTourney(
  config: TournamentConfigInput,
  seats: readonly number[],
  deckForHand?: (n: number) => Deck | undefined,
): TournamentEngine {
  return new TournamentEngine(config, new SeededRandomSource(42), seats.map(seat), {
    firstDealerSeat: seats[0],
    deckForHand,
  });
}

/** 与引擎发牌消费顺序一致：两轮底牌（按 dealOrder round1/round2）→ burn/flop3/burn/turn/burn/river。 */
function buildDeck(
  seats: readonly number[],
  dealer: number,
  holeBySeat: Record<number, [string, string]>,
  board: readonly string[],
): Deck {
  const order = dealOrder(seats, dealer);
  const holeCodes: string[] = [];
  for (const s of order) holeCodes.push(holeBySeat[s]![0]);
  for (const s of order) holeCodes.push(holeBySeat[s]![1]);
  const known = [...holeCodes, ...board];
  const used = new Set(known.map((c) => cardKey(parseCard(c))));
  const unused = createStandardDeck().filter((c) => !used.has(cardKey(c))).map(cardCode);
  let ui = 0;
  const burn = () => unused[ui++]!;
  const codes: string[] = [...holeCodes];
  if (board.length > 0) {
    codes.push(burn());
    codes.push(board[0]!, board[1]!, board[2]!);
    if (board.length >= 4) {
      codes.push(burn());
      codes.push(board[3]!);
    }
    if (board.length >= 5) {
      codes.push(burn());
      codes.push(board[4]!);
    }
  }
  const usedCodes = new Set(codes);
  const rest = createStandardDeck().filter((c) => !usedCodes.has(cardKey(c)));
  const full = [...codes.map((c) => parseCard(c)), ...rest];
  return {
    toArray: () => full,
    draw: () => full.shift()!,
    shuffle: () => {},
    size: full.length,
  } as unknown as Deck;
}

function dealOrder(seats: readonly number[], dealer: number): number[] {
  if (seats.length === 2) return [dealer, ...seats.filter((s) => s !== dealer)];
  const sorted = [...seats].sort((a, b) => a - b);
  const idx = sorted.findIndex((s) => s > dealer);
  const start = idx === -1 ? 0 : idx;
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) out.push(sorted[(start + i) % sorted.length]!);
  return out;
}

/** 让所有当前行动者全部 FOLD，直到一手结束（最后的 BB 赢得底池，无人被淘汰）。 */
function foldEveryone(t: TournamentEngine): void {
  let guard = 0;
  while (t.getState().handInProgress && guard < 30) {
    const hand = t.getState().hand;
    if (!hand || hand.phase === "hand_end") break;
    const actor = hand.currentActor;
    if (actor === null) break;
    t.applyAction({ type: "fold", seatIndex: actor, source: "human_socket" });
    guard++;
  }
}

/** 让所有当前行动者尽快 ALL-IN，直到一手结束（触发 Runout）；不可 all-in 则以 call 完成全下。 */
function allInEveryone(t: TournamentEngine): void {
  let guard = 0;
  while (t.getState().handInProgress && guard < 30) {
    const hand = t.getState().hand;
    if (!hand || hand.phase === "hand_end") break;
    const actor = hand.currentActor;
    if (actor === null) break;
    const la = t.getLegalActions();
    const type = la.canAllIn ? "all-in" : la.canCall ? "call" : "check";
    t.applyAction({ type, seatIndex: actor, source: "human_socket" });
    guard++;
  }
}

describe("TournamentEngine 首手 Dealer 与状态", () => {
  it("首手 Dealer 由注入 RNG 从 ACTIVE 座位选择并写入状态", () => {
    const t = new TournamentEngine(fixedCfg(), new SeededRandomSource(7), [seat(0), seat(1), seat(2)]);
    const state = t.getState();
    expect([0, 1, 2]).toContain(state.dealerSeat);
    expect(state.phase).toBe("running");
    t.startNextHand();
    expect(t.getState().handInProgress).toBe(true);
    const hand = t.getState().hand!;
    expect(hand.seats.map((s) => s.seatIndex)).toEqual([0, 1, 2]);
    expect(hand.dealerSeat).toBe(state.dealerSeat);
  });
});

describe("TournamentEngine 淘汰、Heads-Up 与冠军", () => {
  it("同手多人淘汰：优先生存者夺冠，其余共享 placementRange 并按 seatIndex 稳定排序", () => {
    const seats = [0, 1, 2];
    const decks: Deck[] = [
      buildDeck(seats, 0, { 0: ["2c", "7d"], 1: ["As", "Ah"], 2: ["Ks", "Kh"] }, ["2d", "3c", "4d", "8s", "9h"]),
    ];
    const t = makeTourney(fixedCfg(), seats, (n) => decks[n - 1]);
    t.startNextHand();
    allInEveryone(t);
    const state = t.getState();
    expect(state.phase).toBe("finished");
    expect(state.champion).toBe(1); // seat1(AA)
    expect(state.eliminations).toHaveLength(1);
    const group = state.eliminations[0]!;
    expect(group.handNumber).toBe(1);
    expect(group.placementRange).toEqual({ from: 2, to: 3 });
    expect(group.players).toEqual([0, 2]); // 同 stack → seatIndex 升序
    const p0 = state.participants.find((p) => p.seatIndex === 0)!;
    const p2 = state.participants.find((p) => p.seatIndex === 2)!;
    expect(p0.finish).toEqual({ placementRange: { from: 2, to: 3 }, displayOrder: 1 });
    expect(p2.finish).toEqual({ placementRange: { from: 2, to: 3 }, displayOrder: 2 });
    expect(state.participants.find((p) => p.seatIndex === 1)!.finish).toEqual({
      placementRange: { from: 1, to: 1 },
      displayOrder: 1,
    });
    expect(state.finalStandings.map((f) => f.seatIndex)).toEqual([1, 0, 2]);
    const events = t.getEvents();
    expect(events.filter((e) => e.type === "PLAYER_ELIMINATED").map((e) => (e as { seatIndex: number }).seatIndex).sort()).toEqual([0, 2]);
    expect(events.filter((e) => e.type === "TOURNAMENT_FINISHED")).toHaveLength(1);
  });

  it("Heads-Up 切换：单人淘汰后下一手 Dealer 轮转、HU 盲注；再全下产生唯一冠军", () => {
    const seats = [0, 1, 2];
    const decks: Deck[] = [
      // 手 1：seat0/seat1 平局（AA/KK 对 + 公共 4 A/K），seat2 最差 → 仅 seat2 淘汰，剩 [0,1]。
      buildDeck(seats, 0, { 0: ["As", "Ks"], 1: ["Ah", "Kh"], 2: ["2c", "7d"] }, ["Ac", "Ad", "Kd", "Kc", "3c"]),
      // 手 2（HU，dealer=1）：seat0(AA) 对 seat1(KK)，seat0 全取 300 → seat1 淘汰，seat0 冠军。
      buildDeck([0, 1], 1, { 0: ["As", "Ah"], 1: ["Ks", "Kh"] }, ["2d", "3c", "4d", "8s", "9h"]),
    ];
    const t = makeTourney(fixedCfg(), seats, (n) => decks[n - 1]);
    t.startNextHand();
    allInEveryone(t);
    let state = t.getState();
    expect(state.phase).toBe("running");
    expect(state.champion).toBeNull();
    expect(state.eliminations[0]!.players).toEqual([2]);
    expect(state.eliminations[0]!.placementRange).toEqual({ from: 3, to: 3 }); // 最后一名（3 人中）
    expect(state.participants.find((p) => p.seatIndex === 0)!.chips).toBe(150);
    expect(state.participants.find((p) => p.seatIndex === 1)!.chips).toBe(150);
    expect(state.participants.find((p) => p.seatIndex === 2)!.status).toBe("ELIMINATED");

    t.startNextHand();
    state = t.getState();
    expect(state.handNumber).toBe(2);
    expect(state.dealerSeat).toBe(1); // 0→1 顺移
    expect(state.hand!.sbSeat).toBe(1); // HU Dealer=SB
    expect(state.hand!.bbSeat).toBe(0);
    expect(state.hand!.seats.map((s) => s.seatIndex)).toEqual([0, 1]); // 淘汰者不在手

    allInEveryone(t);
    state = t.getState();
    expect(state.phase).toBe("finished");
    expect(state.champion).toBe(0);
    expect(state.eliminations[1]!.players).toEqual([1]);
    expect(state.eliminations[1]!.placementRange).toEqual({ from: 2, to: 2 });
    expect(state.finalStandings.map((f) => f.seatIndex)).toEqual([0, 1, 2]);
  });
});

describe("TournamentEngine 盲注推进（只在 Hand 间生效）", () => {
  it("按手数升盲：每 N 手换级且只在 Hand 间生效；下降后最小加注按当前 BB 重算", () => {
    const seats = [0, 1, 2];
    const structure = [
      { smallBlind: 10, bigBlind: 20, hands: 2 },
      { smallBlind: 5, bigBlind: 10, hands: 2 }, // 下降
    ];
    const t = makeTourney(fixedCfg({ blindMode: "hands", blindStructure: structure }), seats);
    for (let h = 1; h <= 2; h++) {
      t.startNextHand();
      expect(t.getState().bigBlind).toBe(20);
      foldEveryone(t);
    }
    t.startNextHand();
    expect(t.getState().blindLevel).toBe(1);
    expect(t.getState().bigBlind).toBe(10); // 下降后当前等级 BB
    expect(t.getState().hand!.bigBlind).toBe(10);
    expect(t.getLegalActions().callAmount).toBe(10); // 跟注到当前 BB
    expect(t.getLegalActions().minRaiseTo).toBe(20); // 下降后最小加注按新 BB(10) 重算（10+10），非旧 40
    foldEveryone(t);
  });

  it("固定模式：盲注恒为初始值", () => {
    const t = makeTourney(fixedCfg(), [0, 1, 2]);
    for (let h = 0; h < 3; h++) {
      t.startNextHand();
      expect(t.getState().bigBlind).toBe(20);
      foldEveryone(t);
    }
  });
});

describe("TournamentEngine 退出/撤回与筹码守恒", () => {
  it("手间撤回：WITHDRAWN + forfeitedChips，筹码守恒成立", () => {
    const t = makeTourney(fixedCfg({ startingStack: 100 }), [0, 1, 2, 3]);
    t.withdrawParticipant(2);
    const state = t.getState();
    const p2 = state.participants.find((p) => p.seatIndex === 2)!;
    expect(p2.status).toBe("WITHDRAWN");
    expect(p2.chips).toBe(0);
    expect(state.forfeitedChips).toBe(100);
    expect(state.forfeitedChips + state.participants.filter((p) => p.status === "ACTIVE").reduce((s, p) => s + p.chips, 0)).toBe(400);
    expect(state.participants.filter((p) => p.status === "ACTIVE").map((p) => p.chips)).toEqual([100, 100, 100]);
  });

  it("进行中 Hand 撤回：未 all-in 且可行动者立即弃权折叠；Hand 末 WITHDRAWN + forfeitedChips", () => {
    const seats = [0, 1, 2];
    const decks: Deck[] = [
      // 手 1：seat0(UTG) 全下、seat1(SB) 全下 → 轮到 seat2(BB，可行动) 时撤回折叠。
      // seat0(AA) 胜 seat1(KK)；seat2 折叠后 80 被没收，seat1 淘汰 → seat0 冠军。
      buildDeck(seats, 0, { 0: ["As", "Ah"], 1: ["Ks", "Kh"], 2: ["2c", "7d"] }, ["2d", "3c", "4d", "8s", "9h"]),
    ];
    const t = makeTourney(fixedCfg(), seats, (n) => decks[n - 1]);
    t.startNextHand();
    t.applyAction({ type: "all-in", seatIndex: 0, source: "human_socket" });
    t.applyAction({ type: "call", seatIndex: 1, source: "human_socket" }); // SB 短跟全下（allInTo==currentBet）
    t.withdrawParticipant(2); // 可行动者撤回 → 立即折叠 → runout → 一手结束
    const state = t.getState();
    const p2 = state.participants.find((p) => p.seatIndex === 2)!;
    expect(p2.status).toBe("WITHDRAWN");
    expect(p2.chips).toBe(0);
    expect(state.forfeitedChips).toBe(80); // 100 - 已投 BB 20
    expect(state.participants.find((p) => p.seatIndex === 1)!.status).toBe("ELIMINATED");
    expect(state.phase).toBe("finished");
    expect(state.champion).toBe(0);
    expect(state.participants.find((p) => p.seatIndex === 0)!.chips).toBe(220); // 100 + 主池220
    expect(state.forfeitedChips + state.participants.find((p) => p.seatIndex === 0)!.chips).toBe(300); // 守恒
  });

  it("淘汰/撤回者不可参与下一手", () => {
    const seats = [0, 1, 2];
    const decks: Deck[] = [
      buildDeck(seats, 0, { 0: ["2c", "7d"], 1: ["As", "Ah"], 2: ["Ks", "Kh"] }, ["2d", "3c", "4d", "8s", "9h"]),
    ];
    const t = makeTourney(fixedCfg(), seats, (n) => decks[n - 1]);
    t.startNextHand();
    allInEveryone(t);
    expect(t.getState().phase).toBe("finished"); // seat1 冠军，0/2 淘汰
    expect(() => t.startNextHand()).toThrow();
  });
});

describe("TournamentEngine 事件序列与非法指令原子性", () => {
  it("主事件流 sequence 单调且对所有合法转移递增", () => {
    const seats = [0, 1, 2];
    const decks: Deck[] = [
      buildDeck(seats, 0, { 0: ["As", "Ah"], 1: ["Ks", "Kh"], 2: ["2c", "7d"] }, ["2d", "3c", "4d", "8s", "9h"]),
    ];
    const t = makeTourney(fixedCfg(), seats, (n) => decks[n - 1]);
    t.startNextHand();
    allInEveryone(t);
    const seqs = t.getEvents().map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(t.getEvents().every((e) => Number.isInteger(e.sequence))).toBe(true);
  });

  it("非法指令（无进行中手时 applyAction / 撤回非 ACTIVE）抛错且状态、事件、sequence 不变", () => {
    const t = makeTourney(fixedCfg(), [0, 1]);
    const before = t.getState();
    const beforeEvents = t.getEvents();
    expect(() => t.applyAction({ type: "fold", seatIndex: 0, source: "human_socket" })).toThrow();
    expect(t.getState()).toEqual(before);
    expect(t.getEvents()).toEqual(beforeEvents);
    const afterWithdraw = (t.withdrawParticipant(0), t.getState()); // 手间 → WITHDRAWN
    expect(() => t.withdrawParticipant(0)).toThrow(); // 已 WITHDRAWN
    expect(t.getState()).toEqual(afterWithdraw);
  });
});
