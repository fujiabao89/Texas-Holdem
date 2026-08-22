import { describe, expect, it } from "vitest";
import { Deck, EmptyDeckError, createStandardDeck } from "./deck";
import { SUITS, RANKS, createCard, cardKey } from "./card";
import { SeededRandomSource } from "./random-source";

function expectedStandardKeys(): Set<string> {
  const keys = new Set<string>();
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      keys.add(cardKey(createCard(suit, rank)));
    }
  }
  return keys;
}

describe("标准牌堆", () => {
  it("初始恰为 52 张且无重复、无缺失", () => {
    const deck = new Deck();
    expect(deck.size).toBe(52);
    const actual = new Set(deck.toArray().map(cardKey));
    expect(actual).toEqual(expectedStandardKeys());
  });

  it("createStandardDeck 返回 52 张", () => {
    const cards = createStandardDeck();
    expect(cards).toHaveLength(52);
    expect(new Set(cards.map(cardKey))).toEqual(expectedStandardKeys());
  });

  it("未洗牌时按顺序抽牌不重复，且抽完恰为 52 张", () => {
    const deck = new Deck();
    const drawn = new Set<string>();
    for (let i = 0; i < 52; i++) {
      const key = cardKey(deck.draw());
      expect(drawn.has(key)).toBe(false);
      drawn.add(key);
    }
    expect(deck.size).toBe(0);
  });
});

describe("洗牌", () => {
  it("洗牌后仍是同一集合（排列）", () => {
    const deck = new Deck();
    const before = new Set(deck.toArray().map(cardKey));
    deck.shuffle(new SeededRandomSource(1));
    const after = new Set(deck.toArray().map(cardKey));
    expect(after).toEqual(before);
    expect(deck.toArray()).toHaveLength(52);
  });

  it("洗牌会改变顺序（对典型 seed）", () => {
    const ordered = new Deck().toArray().map(cardKey);
    const shuffled = new Deck();
    shuffled.shuffle(new SeededRandomSource(123));
    expect(shuffled.toArray().map(cardKey)).not.toEqual(ordered);
  });

  it("固定 seed 洗牌 100% 复现", () => {
    const order = (seed: number) => {
      const deck = new Deck();
      deck.shuffle(new SeededRandomSource(seed));
      return deck.toArray().map(cardKey);
    };
    expect(order(99)).toEqual(order(99));
    expect(order(99)).not.toEqual(order(100));
  });
});

describe("抽牌与耗尽", () => {
  it("洗牌后抽完全部视为初始集合", () => {
    const deck = new Deck();
    const initial = new Set(deck.toArray().map(cardKey));
    deck.shuffle(new SeededRandomSource(1));
    const drawn = new Set<string>();
    for (let i = 0; i < 52; i++) {
      drawn.add(cardKey(deck.draw()));
    }
    expect(drawn).toEqual(initial);
  });

  it("牌堆耗尽抛 EmptyDeckError 而非空值", () => {
    const deck = new Deck();
    for (let i = 0; i < 52; i++) {
      deck.draw();
    }
    expect(() => deck.draw()).toThrow(EmptyDeckError);
    expect(deck.size).toBe(0);
  });
});
