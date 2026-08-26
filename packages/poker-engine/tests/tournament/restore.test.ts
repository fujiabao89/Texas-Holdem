import { describe, it, expect } from "vitest";
import { TournamentEngine, SeededRandomSource } from "../../src";
import type { TournamentConfigInput, TournamentState } from "../../src";
import type { TournamentParticipantConfig } from "../../src";

/**
 * TournamentEngine.restore 崩溃恢复重建测试（docs/04 §13；docs/03 §4.3/§7.5）。
 *
 * 只测「手末边界快照 → restore → 继续运行」的机械重建正确性；规则语义本身不在本文件
 * 重复覆盖（见 tests/tournament/engine.test.ts）。
 */

function seat(i: number): TournamentParticipantConfig {
  return { seatIndex: i, name: `P${i}`, kind: "human" };
}

function fixedCfg(): TournamentConfigInput {
  return {
    maxPlayers: 6,
    startingStack: 100,
    smallBlind: 10,
    bigBlind: 20,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
    actionTime: 30,
    timeBank: 60,
  };
}

function makeTourney(seats: readonly number[]): TournamentEngine {
  return new TournamentEngine(fixedCfg(), new SeededRandomSource(42), seats.map(seat), {
    firstDealerSeat: seats[0],
  });
}

/** 让所有当前行动者全部 FOLD 直到一手结束（BB 收底，无人被淘汰）。 */
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

function playHands(t: TournamentEngine, count: number): void {
  for (let i = 0; i < count; i++) {
    t.startNextHand();
    foldEveryone(t);
  }
}

/** 断言两状态除 `hand`（恢复后为空）外逐字段相等。 */
function expectStateEqualExceptHand(a: TournamentState, b: TournamentState): void {
  expect(b.phase).toBe(a.phase);
  expect(b.handNumber).toBe(a.handNumber);
  expect(b.handInProgress).toBe(a.handInProgress);
  expect(b.blindLevel).toBe(a.blindLevel);
  expect(b.smallBlind).toBe(a.smallBlind);
  expect(b.bigBlind).toBe(a.bigBlind);
  expect(b.dealerSeat).toBe(a.dealerSeat);
  expect(b.forfeitedChips).toBe(a.forfeitedChips);
  expect(b.initialTotalChips).toBe(a.initialTotalChips);
  expect(b.champion).toBe(a.champion);
  expect(b.elapsedSeconds).toBe(a.elapsedSeconds);
  expect(b.nextSequence).toBe(a.nextSequence);
  expect(b.eliminations).toEqual(a.eliminations);
  expect(b.finalStandings).toEqual(a.finalStandings);
  expect(b.participants).toEqual(a.participants);
  expect(b.config).toEqual(a.config);
}

describe("TournamentEngine.restore（崩溃恢复重建）", () => {
  it("手末边界快照 roundtrip：恢复后除 hand 外状态逐字段相等", () => {
    const original = makeTourney([0, 1, 2]);
    playHands(original, 2);
    expect(original.getState().handInProgress).toBe(false);

    const restored = TournamentEngine.restore(original.getState(), new SeededRandomSource(42), {
      firstDealerSeat: 0,
    });
    expectStateEqualExceptHand(original.getState(), restored.getState());
    // 恢复后无进行中的手：hand 为空，待下一手重新建立。
    expect(restored.getState().hand).toBeNull();
  });

  it("恢复后可继续运行且事件内部 sequence 从快照 nextSequence 无缝延续", () => {
    const original = makeTourney([0, 1, 2]);
    playHands(original, 2);
    const snapshot = original.getState();
    const committedCount = snapshot.nextSequence;
    expect(committedCount).toBeGreaterThan(0);

    const restored = TournamentEngine.restore(snapshot, new SeededRandomSource(42), {
      firstDealerSeat: 0,
    });
    // 恢复后事件流为空：不重放已提交事件。
    expect(restored.getEvents()).toHaveLength(0);

    restored.startNextHand();
    foldEveryone(restored);
    const newEvents = restored.getEvents();
    expect(newEvents.length).toBeGreaterThan(0);
    // 第一手新事件内部 sequence = 快照 nextSequence；且严格连续。
    expect(newEvents[0]!.sequence).toBe(committedCount);
    for (let i = 1; i < newEvents.length; i++) {
      expect(newEvents[i]!.sequence).toBe(newEvents[i - 1]!.sequence + 1);
    }
    // 恢复后的下一手可从手末继续：startNextHand 正常推进。
    restored.startNextHand();
    expect(restored.getState().handInProgress).toBe(true);
  });

  it("淘汰/排名从快照恢复（快照参与者携带 finish/status）", () => {
    const original = makeTourney([0, 1, 2]);
    // 全下到底：导致筹码低的玩家被淘汰，产生 eliminations/finalStandings 数据。
    original.startNextHand();
    let guard = 0;
    while (original.getState().handInProgress && guard < 30) {
      const hand = original.getState().hand;
      if (!hand || hand.phase === "hand_end") break;
      const actor = hand.currentActor;
      if (actor === null) break;
      const la = original.getLegalActions();
      const type = la.canAllIn ? "all-in" : la.canCall ? "call" : "check";
      original.applyAction({ type, seatIndex: actor, source: "human_socket" });
      guard++;
    }
    const snapshot = original.getState();
    // 构造快照时该手已结束；若已产生淘汰则断言恢复保持；否则直接跳过（此处全下 100/100/100 大概率淘汰 1–2 人）。
    const restored = TournamentEngine.restore(snapshot, new SeededRandomSource(42), {
      firstDealerSeat: 0,
    });
    expectStateEqualExceptHand(snapshot, restored.getState());
    expect(restored.getState().eliminations).toEqual(snapshot.eliminations);
    expect(restored.getState().finalStandings).toEqual(snapshot.finalStandings);
  });

  it("拒绝进行中手快照（handInProgress=true）", () => {
    const t = makeTourney([0, 1]);
    t.startNextHand();
    expect(t.getState().handInProgress).toBe(true);
    expect(() => TournamentEngine.restore(t.getState(), new SeededRandomSource(42))).toThrow(
      /仅接受手末边界快照/,
    );
  });
});
