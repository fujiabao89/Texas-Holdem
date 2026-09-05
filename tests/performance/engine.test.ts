import { describe, expect, it } from "vitest";

import {
  chooseAction,
  classifyRejected,
  isLoopbackHost,
  normalizeServerBase,
  prng01,
  serverInfoFrom,
  submitActionCommand,
} from "./engine";
import { MetricsCollector } from "./metrics";

describe("engine.chooseAction（合法动作选择）", () => {
  const alwaysZero = (): number => 0;
  const alwaysHigh = (): number => 0.99;
  it("canCheck → CHECK（优先过牌）", () => {
    expect(
      chooseAction(
        {
          canFold: true,
          canCheck: true,
          canCall: false,
          callAmount: 0,
          canBet: false,
          minBetTo: null,
          canRaise: false,
          minRaiseTo: null,
          maxRaiseTo: 0,
          canAllIn: false,
          allInTo: 0,
        },
        alwaysZero,
      ),
    ).toEqual({ type: "CHECK" });
  });
  it("不能过牌时低随机可加注 minRaiseTo；否则 CALL", () => {
    const legal = {
      canFold: true,
      canCheck: false,
      canCall: true,
      callAmount: 10,
      canBet: false,
      minBetTo: null,
      canRaise: true,
      minRaiseTo: 100,
      maxRaiseTo: 500,
      canAllIn: false,
      allInTo: 0,
    };
    expect(chooseAction(legal, alwaysZero)).toEqual({ type: "RAISE", raiseTo: 100 });
    expect(chooseAction(legal, alwaysHigh)).toEqual({ type: "CALL" });
  });
  it("无 CALL 且可 BET → BET minBetTo", () => {
    const legal = {
      canFold: true,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canBet: true,
      minBetTo: 20,
      canRaise: false,
      minRaiseTo: null,
      maxRaiseTo: 0,
      canAllIn: false,
      allInTo: 0,
    };
    expect(chooseAction(legal, alwaysHigh)).toEqual({ type: "BET", betTo: 20 });
  });
  it("只有 ALL_IN / FOLD 时按序选择", () => {
    const onlyAllIn = {
      canFold: true,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canBet: false,
      minBetTo: null,
      canRaise: false,
      minRaiseTo: null,
      maxRaiseTo: 0,
      canAllIn: true,
      allInTo: 300,
    };
    expect(chooseAction(onlyAllIn, alwaysHigh)).toEqual({ type: "ALL_IN" });
    const onlyFold = {
      canFold: true,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canBet: false,
      minBetTo: null,
      canRaise: false,
      minRaiseTo: null,
      maxRaiseTo: 0,
      canAllIn: false,
      allInTo: 0,
    };
    expect(chooseAction(onlyFold, alwaysHigh)).toEqual({ type: "FOLD" });
  });
});

describe("engine 基址安全校验（Codex/CodeRabbit 安全项）", () => {
  it("loopback 明文 http 允许，WS 仍为明文 ws（本地测试）", () => {
    const info = serverInfoFrom("http://127.0.0.1:3401/");
    expect(info.httpBase).toBe("http://127.0.0.1:3401");
    expect(info.wsBase).toBe("ws://127.0.0.1:3401/api/v1/ws");
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(normalizeServerBase("http://localhost:3401")).toBe("http://localhost:3401");
  });

  it("远端仅允许 https；https 基址的 WS 为 wss", () => {
    const info = serverInfoFrom("https://game.example.com:8443");
    expect(info.httpBase).toBe("https://game.example.com:8443");
    expect(info.wsBase).toBe("wss://game.example.com:8443/api/v1/ws");
  });

  it("拒绝远端明文 http（防止明文发送 playerToken）；拒绝非法 URL", () => {
    expect(() => serverInfoFrom("http://game.example.com:3001")).toThrow(/明文|loopback/);
    expect(() => normalizeServerBase("game.example.com:3001")).toThrow(/非法基址|不受支持/);
    expect(() => normalizeServerBase("ftp://example.com/x")).toThrow(/不受支持/);
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
    const { frame, requestId } = submitActionCommand("tournament-1", "42", {
      type: "RAISE",
      raiseTo: 200,
    });
    const cmd = frame as {
      type: string;
      requestId: string;
      payload: {
        tournamentId: string;
        actionId: string;
        expectedSequence: string;
        action: { type: string };
      };
    };
    expect(cmd.type).toBe("SUBMIT_ACTION");
    expect(cmd.payload.tournamentId).toBe("tournament-1");
    expect(cmd.payload.expectedSequence).toBe("42");
    expect(cmd.payload.action.type).toBe("RAISE");
    expect(cmd.payload.actionId.length).toBeGreaterThan(0);
    expect(cmd.requestId).toBe(requestId);
  });
});
