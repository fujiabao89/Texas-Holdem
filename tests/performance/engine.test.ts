import { describe, expect, it } from "vitest";

import { chooseAction, classifyRejected, prng01, submitActionCommand } from "./engine";
import { MetricsCollector } from "./metrics";

describe("engine.chooseAction（合法动作选择）", () => {
  const alwaysZero = (): number => 0;
  const alwaysHigh = (): number => 0.99;
  it("canCheck → CHECK（优先过牌）", () => {
    expect(
      chooseAction({ canFold: true, canCheck: true, canCall: false, callAmount: 0, canBet: false, minBetTo: null, canRaise: false, minRaiseTo: null, maxRaiseTo: 0, canAllIn: false, allInTo: 0 }, alwaysZero),
    ).toEqual({ type: "CHECK" });
  });
  it("不能过牌时低随机可加注 minRaiseTo；否则 CALL", () => {
    const legal = { canFold: true, canCheck: false, canCall: true, callAmount: 10, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 100, maxRaiseTo: 500, canAllIn: false, allInTo: 0 };
    expect(chooseAction(legal, alwaysZero)).toEqual({ type: "RAISE", raiseTo: 100 });
    expect(chooseAction(legal, alwaysHigh)).toEqual({ type: "CALL" });
  });
  it("无 CALL 且可 BET → BET minBetTo", () => {
    const legal = { canFold: true, canCheck: false, canCall: false, callAmount: 0, canBet: true, minBetTo: 20, canRaise: false, minRaiseTo: null, maxRaiseTo: 0, canAllIn: false, allInTo: 0 };
    expect(chooseAction(legal, alwaysHigh)).toEqual({ type: "BET", betTo: 20 });
  });
  it("只有 ALL_IN / FOLD 时按序选择", () => {
    const onlyAllIn = { canFold: true, canCheck: false, canCall: false, callAmount: 0, canBet: false, minBetTo: null, canRaise: false, minRaiseTo: null, maxRaiseTo: 0, canAllIn: true, allInTo: 300 };
    expect(chooseAction(onlyAllIn, alwaysHigh)).toEqual({ type: "ALL_IN" });
    const onlyFold = { canFold: true, canCheck: false, canCall: false, callAmount: 0, canBet: false, minBetTo: null, canRaise: false, minRaiseTo: null, maxRaiseTo: 0, canAllIn: false, allInTo: 0 };
    expect(chooseAction(onlyFold, alwaysHigh)).toEqual({ type: "FOLD" });
  });
});

describe("engine.prng01 / classifyRejected / submitActionCommand", () => {
  it("prng01 确定性且值域 [0,1)", () => {
    const a = prng01(7);
    const b = prng01(7);
    const first = a();
    expect(b()).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("classifyRejected：竞态码不计回归；其余计入 invariantViolations", () => {
    const metrics = new MetricsCollector();
    classifyRejected("STALE_GAME_STATE", metrics);
    classifyRejected("NOT_YOUR_TURN", metrics);
    classifyRejected("INVALID_AMOUNT", metrics);
    classifyRejected(undefined, metrics);
    expect(metrics.snapshot().invariantViolations).toBe(2);
  });

  it("submitActionCommand 生成含 requestId/actionId/expectedSequence/action 的命令帧", () => {
    const { frame, requestId } = submitActionCommand("tournament-1", "42", { type: "RAISE", raiseTo: 200 });
    const cmd = frame as {
      type: string;
      requestId: string;
      payload: { tournamentId: string; actionId: string; expectedSequence: string; action: { type: string } };
    };
    expect(cmd.type).toBe("SUBMIT_ACTION");
    expect(cmd.payload.tournamentId).toBe("tournament-1");
    expect(cmd.payload.expectedSequence).toBe("42");
    expect(cmd.payload.action.type).toBe("RAISE");
    expect(cmd.payload.actionId.length).toBeGreaterThan(0);
    expect(cmd.requestId).toBe(requestId);
  });
});
