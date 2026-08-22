import { describe, expect, it } from "vitest";
import {
  evaluateHand,
  compareEvaluations,
  decideOutcome,
  handRankName,
  HandRank,
  InvalidHandCountError,
  InvalidCardError,
  DuplicateCardError,
  type HandEvaluation,
} from "./hand-evaluator";
import { parseCard, cardCode } from "./card";
import type { Card } from "./card";

function cards(codes: string[]): Card[] {
  return codes.map((code) => parseCard(code));
}

function ev(...codes: string[]): HandEvaluation {
  return evaluateHand(cards(codes));
}

function codesOf(evaluation: HandEvaluation): string[] {
  return evaluation.bestFiveCards.map(cardCode);
}

describe("九种牌型类别", () => {
  it("High Card", () => {
    expect(ev("2c", "4d", "6h", "8s", "9h").rank).toBe(HandRank.HighCard);
  });

  it("One Pair", () => {
    expect(ev("5c", "5d", "Ah", "Kh", "Qh").rank).toBe(HandRank.OnePair);
  });

  it("Two Pair", () => {
    expect(ev("Ah", "Ad", "Kh", "Kd", "2c").rank).toBe(HandRank.TwoPair);
  });

  it("Three of a Kind", () => {
    expect(ev("7c", "7d", "7h", "As", "Ks").rank).toBe(HandRank.ThreeOfAKind);
  });

  it("Straight", () => {
    expect(ev("5c", "6d", "7h", "8s", "9h").rank).toBe(HandRank.Straight);
  });

  it("Flush", () => {
    expect(ev("2h", "5h", "9h", "Jh", "Kh").rank).toBe(HandRank.Flush);
  });

  it("Full House", () => {
    expect(ev("7c", "7d", "7h", "Ks", "Kd").rank).toBe(HandRank.FullHouse);
  });

  it("Four of a Kind", () => {
    expect(ev("8c", "8d", "8h", "8s", "Ah").rank).toBe(HandRank.FourOfAKind);
  });

  it("Straight Flush（含非 Royal）", () => {
    expect(ev("5h", "6h", "7h", "8h", "9h").rank).toBe(HandRank.StraightFlush);
  });

  it("Royal Flush 是最高 Straight Flush，不单列", () => {
    const royal = ev("Th", "Jh", "Qh", "Kh", "Ah");
    expect(royal.rank).toBe(HandRank.StraightFlush);
    expect(royal.comparisonKey[0]).toBe(HandRank.StraightFlush);
  });
});

describe("牌型强弱顺序", () => {
  it("Straight 输给 Flush，Flush 输给 Full House", () => {
    const straight = ev("5c", "6d", "7h", "8s", "9h");
    const flush = ev("2h", "5h", "9h", "Jh", "Kh");
    const fullHouse = ev("7c", "7d", "7h", "Ks", "Kd");
    expect(compareEvaluations(flush, straight)).toBeGreaterThan(0);
    expect(compareEvaluations(fullHouse, flush)).toBeGreaterThan(0);
  });

  it("compareEvaluations / decideOutcome 返回稳定胜负", () => {
    const strong = ev("8c", "8d", "8h", "8s", "Ah");
    const weak = ev("5c", "5d", "Ah", "Kh", "Qh");
    expect(compareEvaluations(strong, weak)).toBe(1);
    expect(compareEvaluations(weak, strong)).toBe(-1);
    expect(decideOutcome(strong, weak)).toBe("win");
    expect(decideOutcome(weak, strong)).toBe("lose");
  });

  it("handRankName 提供可读名称", () => {
    expect(handRankName(HandRank.StraightFlush)).toBe("Straight Flush");
    expect(handRankName(HandRank.TwoPair)).toBe("Two Pair");
  });
});

describe("同一牌型的关键 kicker 比较", () => {
  it("High Card 逐张比较第五张", () => {
    const low = ev("2c", "4d", "6h", "8s", "9h");
    const high = ev("2c", "4d", "6h", "8s", "Th");
    expect(compareEvaluations(high, low)).toBeGreaterThan(0);
  });

  it("One Pair：同对比较 kicker", () => {
    const a = ev("5c", "5d", "Ah", "Kh", "Qh");
    const b = ev("5c", "5d", "Ah", "Kh", "Jh");
    expect(compareEvaluations(a, b)).toBeGreaterThan(0);
  });

  it("Two Pair：比高对、再比低对、再比 kicker", () => {
    const highPairK = ev("Ah", "Ad", "Kh", "Kd", "2c");
    const lowPairQ = ev("Ah", "Ad", "Qh", "Qd", "2c");
    expect(compareEvaluations(highPairK, lowPairQ)).toBeGreaterThan(0);

    const kicker3 = ev("Ah", "Ad", "Kh", "Kd", "3c");
    const kicker2 = ev("Ah", "Ad", "Kh", "Kd", "2c");
    expect(compareEvaluations(kicker3, kicker2)).toBeGreaterThan(0);
  });

  it("Full House：比三条、再比对子", () => {
    const trips8 = ev("8c", "8d", "8h", "Ks", "Kd");
    const trips7 = ev("7c", "7d", "7h", "Ks", "Kd");
    expect(compareEvaluations(trips8, trips7)).toBeGreaterThan(0);

    const pairK = ev("8c", "8d", "8h", "Ks", "Kd");
    const pairQ = ev("8c", "8d", "8h", "Qs", "Qd");
    expect(compareEvaluations(pairK, pairQ)).toBeGreaterThan(0);
  });

  it("Four of a Kind：比四条、再比 kicker", () => {
    const quads9 = ev("9c", "9d", "9h", "9s", "Ah");
    const quads8 = ev("8c", "8d", "8h", "8s", "Ah");
    expect(compareEvaluations(quads9, quads8)).toBeGreaterThan(0);

    const kickerA = ev("8c", "8d", "8h", "8s", "Ah");
    const kickerK = ev("8c", "8d", "8h", "8s", "Kh");
    expect(compareEvaluations(kickerA, kickerK)).toBeGreaterThan(0);
  });

  it("Straight：比最高张", () => {
    const high9 = ev("5c", "6d", "7h", "8s", "9h");
    const highT = ev("6c", "7d", "8h", "9s", "Th");
    expect(compareEvaluations(highT, high9)).toBeGreaterThan(0);
  });

  it("Flush：逐张比高牌", () => {
    const aceHigh = ev("Ah", "5h", "9h", "Jh", "Kh");
    const kingHigh = ev("2h", "5h", "9h", "Jh", "Kh");
    expect(compareEvaluations(aceHigh, kingHigh)).toBeGreaterThan(0);
  });
});

describe("A2345 顺子与普通顺子", () => {
  it("A-2-3-4-5 是最低顺子（5-high）", () => {
    const wheel = ev("Ah", "2c", "3d", "4s", "5h");
    expect(wheel.rank).toBe(HandRank.Straight);
    expect(wheel.comparisonKey[1]).toBe(5);
  });

  it("2-6 顺子大于 5-high 顺子", () => {
    const sixHigh = ev("2c", "3d", "4s", "5h", "6c");
    const wheel = ev("Ah", "2c", "3d", "4s", "5h");
    expect(compareEvaluations(sixHigh, wheel)).toBeGreaterThan(0);
  });

  it("A-high 顺子大于其他顺子", () => {
    const aceHigh = ev("Ah", "Kc", "Qd", "Js", "Th");
    const nineHigh = ev("5c", "6d", "7h", "8s", "9h");
    expect(compareEvaluations(aceHigh, nineHigh)).toBeGreaterThan(0);
  });

  it("同花色 A2345 是 Straight Flush（非普通顺子）", () => {
    const wheelSf = ev("Ah", "2h", "3h", "4h", "5h");
    expect(wheelSf.rank).toBe(HandRank.StraightFlush);
    expect(wheelSf.comparisonKey[1]).toBe(5);
  });
});

describe("board plays：最佳五张完全来自公共牌", () => {
  // 输入顺序遵循 §10：Hole Cards 在前、Community Cards 在后。
  it("公共牌成顺时，组成牌型的是公共牌", () => {
    const result = ev("2c", "2d", "5c", "6d", "7h", "8s", "9h");
    expect(result.rank).toBe(HandRank.Straight);
    expect(codesOf(result)).toEqual(["5c", "6d", "7h", "8s", "9h"]);
  });

  it("公共牌成同花时，组成牌型的是公共牌", () => {
    const result = ev("2c", "3d", "2h", "5h", "9h", "Jh", "Kh");
    expect(result.rank).toBe(HandRank.Flush);
    expect(codesOf(result)).toEqual(["2h", "5h", "9h", "Jh", "Kh"]);
  });

  it("手牌与公共牌都成同值顺子时，偏好公共牌成牌", () => {
    // hole=9s,2d；公共牌 5c,6d,7h,8s,9h。两个 9 高顺子等值，应选公共牌成牌。
    const result = ev("9s", "2d", "5c", "6d", "7h", "8s", "9h");
    expect(result.rank).toBe(HandRank.Straight);
    expect(codesOf(result)).toEqual(["5c", "6d", "7h", "8s", "9h"]);
  });
});

describe("不同 5 张组合中选择真正最强的五张", () => {
  it("在顺子与同花之间选择更强的同花", () => {
    // Ah Kh Th 9h 8h Qs Jd —— 同花（A 高）与 A 高顺子都可用，但同花更强。
    const result = ev("Ah", "Kh", "Th", "9h", "8h", "Qs", "Jd");
    expect(result.rank).toBe(HandRank.Flush);
    expect(codesOf(result)).toEqual(["Ah", "Kh", "Th", "9h", "8h"]);
  });

  it("在三条与顺子之间选择更强的顺子（公共牌成牌）", () => {
    // hole=5s,5h（可成三条）；community=5c,6d,7h,8s,9h（成 9 高顺子）。顺子更强且公共牌成牌。
    const result = ev("5s", "5h", "5c", "6d", "7h", "8s", "9h");
    expect(result.rank).toBe(HandRank.Straight);
    expect(codesOf(result)).toEqual(["5c", "6d", "7h", "8s", "9h"]);
  });
});

describe("输入 6 张", () => {
  it("从 6 张中选出最佳 5 张", () => {
    const result = ev("5c", "6d", "7h", "8s", "9h", "2c");
    expect(result.rank).toBe(HandRank.Straight);
    expect(codesOf(result)).toEqual(["5c", "6d", "7h", "8s", "9h"]);
  });
});

describe("完全平局", () => {
  it("两张手牌 best five 相同则为平局", () => {
    const a = ev("5c", "6d", "7h", "8s", "9h", "2c", "2d");
    const b = ev("5c", "6d", "7h", "8s", "9h", "Ks", "Kd");
    expect(compareEvaluations(a, b)).toBe(0);
    expect(decideOutcome(a, b)).toBe("tie");
    expect(decideOutcome(b, a)).toBe("tie");
  });
});

describe("非法输入", () => {
  it("少于 5 张抛 InvalidHandCountError", () => {
    expect(() => evaluateHand(cards(["5c", "6d", "7h", "8s"]))).toThrow(InvalidHandCountError);
  });

  it("多于 7 张抛 InvalidHandCountError", () => {
    expect(() =>
      evaluateHand(cards(["5c", "6d", "7h", "8s", "9h", "Ts", "Jh", "Qd"])),
    ).toThrow(InvalidHandCountError);
  });

  it("存在重复牌抛 DuplicateCardError", () => {
    expect(() => evaluateHand(cards(["5c", "5c", "7h", "8s", "9h"]))).toThrow(DuplicateCardError);
  });

  it("存在无效 Card 抛 InvalidCardError", () => {
    const invalid = { suit: "spades", rank: 15 } as unknown as Card;
    expect(() =>
      evaluateHand([invalid, parseCard("2c"), parseCard("3d"), parseCard("4s"), parseCard("5h")]),
    ).toThrow(InvalidCardError);
  });

  it("循环对象作为无效 Card 抛 InvalidCardError（而非原生 TypeError）", () => {
    const circular: { suit: string; rank: number; self?: unknown } = { suit: "spades", rank: 15 };
    circular.self = circular;
    expect(() =>
      evaluateHand([
        circular as unknown as Card,
        parseCard("2c"),
        parseCard("3d"),
        parseCard("4s"),
        parseCard("5h"),
      ]),
    ).toThrow(InvalidCardError);
  });
});
