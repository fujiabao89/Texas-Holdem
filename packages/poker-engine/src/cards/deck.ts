/**
 * 标准 52 张牌堆（TEX-13）。
 *
 * - 初始恰为 52 张、无重复、无缺失，无 Joker；
 * - `shuffle` 使用 Fisher–Yates，随机性来自注入的 {@link RandomSource}，洗牌后仍是同一集合；
 * - `draw` 从顶部按序抽牌，牌堆耗尽抛 {@link EmptyDeckError}，绝不返回 undefined 或重复牌。
 *
 * 权威规格：docs/01-engine-spec.md §7 / §15 / §17（牌堆守恒：已发牌 + 剩余 = 初始 52，无重叠分区）。
 */
import { SUITS, RANKS, createCard } from "./card";
import type { Card } from "./card";
import type { RandomSource } from "./random-source";

/** 牌堆耗尽时抛出：抽牌失败必须是显式错误，而非空值。 */
export class EmptyDeckError extends Error {
  constructor() {
    super("牌堆已耗尽：无法继续抽牌");
    this.name = "EmptyDeckError";
  }
}

/**
 * 有状态牌堆。内部数组不对外暴露；抽牌消费顺序固定（从顶部）。
 */
export class Deck {
  private cards: Card[];

  /** 默认构造即标准 52 张。 */
  constructor() {
    this.cards = createStandardDeck();
  }

  /** 显式构造标准牌堆的别名（语义更清晰）。 */
  static standard(): Deck {
    return new Deck();
  }

  /** 剩余牌数。 */
  get size(): number {
    return this.cards.length;
  }

  /** 抽走牌堆顶部一张；牌堆耗尽抛 {@link EmptyDeckError}。 */
  draw(): Card {
    const top = this.cards.shift();
    if (top === undefined) {
      throw new EmptyDeckError();
    }
    return top;
  }

  /**
   * 用 Fisher–Yates 就地洗牌；随机性来自注入的 rng，洗牌结果是一个排列。
   */
  shuffle(rng: RandomSource): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const tmp = this.cards[i];
      this.cards[i] = this.cards[j];
      this.cards[j] = tmp;
    }
  }

  /** 当前剩余牌（防御性拷贝，不暴露内部数组）。 */
  toArray(): Card[] {
    return [...this.cards];
  }
}

/** 标准 52 张：四种花色 × 2..A，唯一、无 Joker。 */
export function createStandardDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(createCard(suit, rank));
    }
  }
  return deck;
}
