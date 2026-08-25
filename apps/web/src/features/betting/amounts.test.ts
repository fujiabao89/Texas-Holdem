import { describe, expect, it } from "vitest";

import { gameSnapshot } from "../../testing-fixtures";
import { clampWager, quickAmounts, wagerRange, wagerStep } from "./amounts";

describe("betting presentation amounts", () => {
  it("uses LegalActions as the only ordinary wager range and reaches exact boundaries", () => {
    const range = wagerRange(gameSnapshot().viewer.legalActions!);
    expect(range).toEqual({ kind: "RAISE", min: 20, max: 990 });
    expect(clampWager(1, range!)).toBe(20);
    expect(clampWager(9_999, range!)).toBe(990);
    expect(wagerStep(10)).toBe(1);
    expect(wagerStep(55)).toBe(6);
  });

  it("presents pre-flop targets as total BB commitments without producing a parallel legal rule", () => {
    const snapshot = gameSnapshot();
    const amounts = quickAmounts(snapshot, wagerRange(snapshot.viewer.legalActions!)!);
    expect(amounts).toEqual([
      { label: "2BB", amount: 20 },
      { label: "2.5BB", amount: 25 },
      { label: "3BB", amount: 30 },
      { label: "4BB", amount: 40 },
    ]);
  });

  it("uses server pot, call amount and street bet for post-flop suggestions", () => {
    const snapshot = gameSnapshot({
      handPhase: "FLOP",
      pots: [{ amount: 90, eligiblePlayerIds: ["player-1", "player-2"] }],
      players: [
        { ...gameSnapshot().players[0]!, streetBet: 10 },
        gameSnapshot().players[1]!,
      ],
    });
    const amounts = quickAmounts(snapshot, wagerRange(snapshot.viewer.legalActions!)!);
    expect(amounts).toEqual([
      { label: "1/3 Pot", amount: 47 },
      { label: "1/2 Pot", amount: 63 },
      { label: "2/3 Pot", amount: 78 },
      { label: "Pot", amount: 110 },
    ]);
  });
});
