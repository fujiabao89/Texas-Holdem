import { describe, expect, it } from "vitest";
import { TournamentEngine, SeededRandomSource } from "../../../packages/poker-engine/src/index";
import { createEventSequenceChecker, assertTournamentStateInvariants } from "./invariant-checks";
import type { PokerEvent } from "../../../packages/poker-engine/src/index";

/** 推进真实锦标赛若干动作，得到进行中的状态。 */
function runningTournamentState() {
  const engine = new TournamentEngine(
    {
      maxPlayers: 4,
      startingStack: 500,
      smallBlind: 10,
      bigBlind: 20,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
    },
    new SeededRandomSource(7),
    [0, 1, 2, 3].map((i) => ({ seatIndex: i, name: `P${i}`, kind: "human" as const })),
  );
  let legal = engine.startNextHand();
  let guard = 0;
  while (legal !== null && guard < 6) {
    const actor = engine.getState().hand!.currentActor!;
    legal = engine.applyAction({ type: legal.canCall ? "call" : "check", seatIndex: actor, source: "human_socket" });
    guard++;
  }
  return engine;
}

describe("assertTournamentStateInvariants", () => {
  it("对真实引擎的每个转移后状态通过（手级 + 锦标赛级不变量复用引擎实现）", () => {
    const engine = runningTournamentState();
    expect(() => assertTournamentStateInvariants(engine.getState())).not.toThrow();
  });
});

describe("createEventSequenceChecker", () => {
  function ev(sequence: number): PokerEvent {
    return { type: "BURN_CARD", street: "flop", sequence } as PokerEvent;
  }

  it("连续 sequence 通过并正确计数", () => {
    const checker = createEventSequenceChecker();
    checker.observe([ev(0), ev(1)]);
    checker.observe([ev(0), ev(1), ev(2)]);
    expect(checker.consumed()).toBe(3);
  });

  it("sequence 出现缺口时抛错", () => {
    const checker = createEventSequenceChecker();
    checker.observe([ev(0), ev(1)]);
    expect(() => checker.observe([ev(0), ev(1), ev(3)])).toThrow(/不连续/);
  });

  it("首个事件未从 0 开始时抛错", () => {
    const checker = createEventSequenceChecker();
    expect(() => checker.observe([ev(1)])).toThrow(/未从 0 开始/);
  });

  it("重复事件（sequence 回退）抛错", () => {
    const checker = createEventSequenceChecker();
    checker.observe([ev(0), ev(1)]);
    expect(() => checker.observe([ev(0), ev(1), ev(1)])).toThrow(/不连续/);
  });
});
