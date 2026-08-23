import { describe, it, expect } from "vitest";
import { buildPots } from "./layering";

describe("buildPots 底池分层", () => {
  it("普通主池+单边池，无未跟注", () => {
    const r = buildPots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 100, folded: false },
      { seatIndex: 2, contribution: 50, folded: false },
    ]);
    expect(r.uncalledReturns).toEqual([]);
    expect(r.pots).toHaveLength(2);
    expect(r.pots[0]).toMatchObject({ index: 0, amount: 150 });
    expect(r.pots[1]).toMatchObject({ index: 1, amount: 100 });
    expect(r.pots[0].eligiblePlayers).toEqual([0, 1, 2]);
    expect(r.pots[1].eligiblePlayers).toEqual([0, 1]);
  });

  it("剥离唯一最大贡献者的未跟注部分", () => {
    const r = buildPots([
      { seatIndex: 0, contribution: 150, folded: false },
      { seatIndex: 1, contribution: 100, folded: true },
    ]);
    expect(r.uncalledReturns).toEqual([{ seatIndex: 0, amount: 50 }]);
    expect(r.pots).toHaveLength(1);
    expect(r.pots[0].amount).toBe(200);
    expect(r.pots[0].eligiblePlayers).toEqual([0]);
  });

  it("顶层唯一者是 fold 玩家：仍先剥离其未跟注，再计为贡献但不获奖", () => {
    const r = buildPots([
      { seatIndex: 0, contribution: 100, folded: true },
      { seatIndex: 1, contribution: 80, folded: false },
      { seatIndex: 2, contribution: 80, folded: false },
    ]);
    expect(r.uncalledReturns).toEqual([{ seatIndex: 0, amount: 20 }]);
    expect(r.pots).toHaveLength(1);
    expect(r.pots[0].amount).toBe(240);
    expect(r.pots[0].contributors).toEqual([0, 1, 2]);
    expect(r.pots[0].eligiblePlayers).toEqual([1, 2]);
  });

  it("三级边池（不同深度）与 Fold 贡献保留；fold 者不入 eligible", () => {
    const r = buildPots([
      { seatIndex: 0, contribution: 50, folded: false },
      { seatIndex: 1, contribution: 100, folded: false },
      { seatIndex: 2, contribution: 150, folded: false },
      { seatIndex: 3, contribution: 150, folded: true },
    ]);
    expect(r.uncalledReturns).toEqual([]);
    expect(r.pots).toHaveLength(3);
    expect(r.pots[0].amount).toBe(200); // 50 × 4
    expect(r.pots[0].eligiblePlayers).toEqual([0, 1, 2]);
    expect(r.pots[1].amount).toBe(150); // (100-50) × 3
    expect(r.pots[1].eligiblePlayers).toEqual([1, 2]);
    expect(r.pots[2].amount).toBe(100); // (150-100) × 2
    expect(r.pots[2].eligiblePlayers).toEqual([2]);
  });
});
