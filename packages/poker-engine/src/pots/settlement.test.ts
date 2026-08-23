import { describe, it, expect } from "vitest";
import { settlePots } from "./settlement";
import { parseCard } from "../cards";
import type { Card } from "../cards";

const c = (code: string): Card => parseCard(code);
const hole = (a: string, b: string): readonly Card[] => [c(a), c(b)];

describe("settlePots 每池独立比牌 + Odd Chip", () => {
  it("平局 Split，Odd Chip 给 Dealer 左首第一个赢家", () => {
    const board = [c("5c"), c("6d"), c("7s"), c("8h"), c("9c")];
    const players = [
      { seatIndex: 0, holeCards: hole("2h", "3h"), folded: false },
      { seatIndex: 1, holeCards: hole("2d", "4d"), folded: false },
    ];
    const pots = [{ index: 0, amount: 45, contributors: [0, 1], eligiblePlayers: [0, 1] }];
    const awards = settlePots(pots, players, board, 0);
    expect(awards).toHaveLength(1);
    const a = awards[0]!;
    expect(a.totalAmount).toBe(45);
    expect(a.winners).toEqual([1, 0]); // 余 1 分给 dealer 左首第一个赢家（seat1）
    expect(a.prizeBySeat).toEqual({ 1: 23, 0: 22 });
  });

  it("单赢家独得全部", () => {
    const board = [c("2c"), c("3d"), c("4s"), c("7h"), c("9c")];
    const players = [
      { seatIndex: 0, holeCards: hole("As", "Ah"), folded: false },
      { seatIndex: 1, holeCards: hole("Ks", "Kh"), folded: false },
    ];
    const pots = [{ index: 0, amount: 40, contributors: [0, 1], eligiblePlayers: [0, 1] }];
    const awards = settlePots(pots, players, board, 0);
    expect(awards[0]!.prizeBySeat).toEqual({ 0: 40 });
    expect(awards[0]!.winners).toEqual([0]);
  });

  it("高牌 vs 对子：对子胜出", () => {
    const board = [c("2c"), c("3d"), c("4s"), c("7h"), c("9c")];
    const players = [
      { seatIndex: 0, holeCards: hole("As", "Qh"), folded: false }, // A 高牌
      { seatIndex: 1, holeCards: hole("9s", "5d"), folded: false }, // 对 9（配公共牌 9c）
    ];
    const pots = [{ index: 0, amount: 40, contributors: [0, 1], eligiblePlayers: [0, 1] }];
    const awards = settlePots(pots, players, board, 0);
    expect(awards[0]!.winners).toEqual([1]); // 对 9 > A 高牌
  });
});
