import { describe, expect, it } from "vitest";
import {
  SUITS,
  RANKS,
  ACE,
  KING,
  createCard,
  isCard,
  cardCode,
  parseCard,
  cardsEqual,
  cardKey,
} from "./card";

describe("Card 模型", () => {
  it("四种花色、2–A 共 13 个牌面值", () => {
    expect(SUITS).toHaveLength(4);
    expect(RANKS).toHaveLength(13);
    expect(RANKS[0]).toBe(2);
    expect(RANKS[12]).toBe(ACE);
    expect(SUITS).toContain("spades");
    expect(SUITS).toContain("clubs");
  });

  it("createCard 构造合法牌", () => {
    expect(createCard("spades", KING)).toEqual({ suit: "spades", rank: KING });
    expect(createCard("hearts", ACE)).toEqual({ suit: "hearts", rank: 14 });
  });

  it("isCard 识别合法牌", () => {
    expect(isCard(createCard("diamonds", 7))).toBe(true);
    expect(isCard({ suit: "clubs", rank: 2 })).toBe(true);
  });

  it("isCard 拒绝非法 rank / suit / 非对象", () => {
    expect(isCard({ suit: "spades", rank: 15 })).toBe(false);
    expect(isCard({ suit: "spades", rank: 1 })).toBe(false);
    expect(isCard({ suit: "joker", rank: 14 })).toBe(false);
    expect(isCard({ suit: "spades", rank: "14" })).toBe(false);
    expect(isCard("As")).toBe(false);
    expect(isCard(null)).toBe(false);
    expect(isCard(undefined)).toBe(false);
  });

  it("cardCode / parseCard 互逆", () => {
    for (const code of ["As", "Kd", "Th", "9c", "2h", "Qc", "5s"]) {
      expect(cardCode(parseCard(code))).toBe(code);
    }
  });

  it("parseCard 拒绝非法码", () => {
    expect(() => parseCard("")).toThrow();
    expect(() => parseCard("1x")).toThrow();
    expect(() => parseCard("Ax")).toThrow();
    expect(() => parseCard("Abc")).toThrow();
    expect(() => parseCard("AA")).toThrow();
  });

  it("cardsEqual / cardKey 语义", () => {
    const a = parseCard("As");
    const b = parseCard("As");
    const c = parseCard("Ah");
    expect(cardsEqual(a, b)).toBe(true);
    expect(cardsEqual(a, c)).toBe(false);
    expect(cardKey(a)).toBe("As");
    expect(cardKey(a)).toBe(cardKey(b));
  });
});
