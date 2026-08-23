import { describe, it, expect } from "vitest";
import { computeLegalActions, resolveCall, updateAggression } from "./betting";
import type { BettingContext, PlayerBetView } from "./betting";

const ctx = (over: Partial<BettingContext> = {}): BettingContext => ({
  currentBet: 0,
  lastFullRaiseSize: 100,
  hasFullBetOrRaise: false,
  bigBlind: 100,
  ...over,
});
const player = (over: Partial<PlayerBetView> = {}): PlayerBetView => ({
  streetBet: 0,
  chips: 1000,
  hasActedThisStreet: false,
  lastDecisionBet: 0,
  lastDecisionRaiseSize: 100,
  ...over,
});

describe("computeLegalActions 下注规则", () => {
  it("首行动者无人下注：可 Bet(≥BB)，不可 Check/Raise", () => {
    const la = computeLegalActions(ctx({ currentBet: 0 }), player());
    expect(la.canBet).toBe(true);
    expect(la.minBetTo).toBe(100);
    expect(la.canRaise).toBe(false);
    expect(la.canCheck).toBe(true);
    expect(la.callAmount).toBe(0);
  });

  it("面对下注可 Call，Call 额=currentBet−streetBet", () => {
    const la = computeLegalActions(
      ctx({ currentBet: 200, hasFullBetOrRaise: true, lastFullRaiseSize: 100 }),
      player({ streetBet: 0 }),
    );
    expect(la.canCall).toBe(true);
    expect(la.callAmount).toBe(200);
    expect(la.canCheck).toBe(false);
    expect(la.canRaise).toBe(true);
    expect(la.minRaiseTo).toBe(300);
    expect(la.maxRaiseTo).toBe(1000);
  });

  it("P0夹具①：多个 Short All-in 累计增量未达完整加注幅度 → 不重开，仅可 Call", () => {
    // A 曾下注 60 面对 currentBet=60（lastFullRaiseSize=50）。后两次短全下 currentBet 升至 85。
    const la = computeLegalActions(
      ctx({ currentBet: 85, lastFullRaiseSize: 50, hasFullBetOrRaise: true, bigBlind: 100 }),
      player({ streetBet: 60, hasActedThisStreet: true, lastDecisionBet: 60, lastDecisionRaiseSize: 50 }),
    );
    expect(la.canRaise).toBe(false); // (85-60)=25 < 50 → 不重开
    expect(la.canCall).toBe(true);
    expect(la.callAmount).toBe(25);
  });

  it("P0夹具②：首笔完整开注后 minRaiseTo = currentBet + lastFullRaiseSize", () => {
    const la = computeLegalActions(
      ctx({ currentBet: 100, lastFullRaiseSize: 100, hasFullBetOrRaise: true, bigBlind: 100 }),
      player(),
    );
    expect(la.canRaise).toBe(true);
    expect(la.minRaiseTo).toBe(200);
  });

  it("连续 Short All-in 累计达到完整加注幅度后重开", () => {
    const la = computeLegalActions(
      ctx({ currentBet: 200, lastFullRaiseSize: 100, hasFullBetOrRaise: true }),
      player({ streetBet: 100, hasActedThisStreet: true, lastDecisionBet: 100, lastDecisionRaiseSize: 100 }),
    );
    expect(la.canRaise).toBe(true);
  });

  it("筹码不足只能 Short Call All-in（canCall=false, canAllIn=true）", () => {
    const la = computeLegalActions(
      ctx({ currentBet: 500, hasFullBetOrRaise: true, lastFullRaiseSize: 100 }),
      player({ streetBet: 0, chips: 100 }),
    );
    expect(la.canCall).toBe(false);
    expect(la.canAllIn).toBe(true);
    expect(la.allInTo).toBe(100);
  });

  it("低于 BB 的短全下：首笔非完整开注，minRaiseTo=BB，后续完整下注至少到 BB", () => {
    const la = computeLegalActions(
      ctx({ currentBet: 30, hasFullBetOrRaise: false, bigBlind: 100 }),
      player(),
    );
    expect(la.canRaise).toBe(true);
    expect(la.minRaiseTo).toBe(100); // 尚无完整开注 → 回到 BB
  });
});

describe("resolveCall", () => {
  it("chips 足够则跟足 callAmount；不足则全下", () => {
    expect(resolveCall(player({ streetBet: 0, chips: 200 }), 150)).toEqual({
      amount: 150,
      newStreetBet: 150,
      newChips: 50,
      isAllIn: false,
    });
    expect(resolveCall(player({ streetBet: 0, chips: 80 }), 150)).toEqual({
      amount: 80,
      newStreetBet: 80,
      newChips: 0,
      isAllIn: true,
    });
  });
});

describe("updateAggression 首笔完整开注基准", () => {
  it("首 bet (CB=0) 取 target 幅度", () => {
    expect(
      updateAggression({ prevCurrentBet: 0, target: 100, bigBlind: 100, hasFullBetOrRaise: false }),
    ).toEqual({ currentBet: 100, lastFullRaiseSize: 100, hasFullBetOrRaise: true });
  });
  it("低于 BB 的短全下之上补至 BB：完整加注基准取 BB", () => {
    expect(
      updateAggression({ prevCurrentBet: 30, target: 100, bigBlind: 100, hasFullBetOrRaise: false }),
    ).toEqual({ currentBet: 100, lastFullRaiseSize: 100, hasFullBetOrRaise: true });
  });
  it("已有完整开注后，加注幅度 = target − currentBet", () => {
    expect(
      updateAggression({ prevCurrentBet: 100, target: 250, bigBlind: 100, hasFullBetOrRaise: true }),
    ).toEqual({ currentBet: 250, lastFullRaiseSize: 150, hasFullBetOrRaise: true });
  });
});
