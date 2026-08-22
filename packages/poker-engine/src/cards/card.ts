/**
 * Card 基础模型（TEX-13）。
 *
 * 四种花色、2–A 牌面值，标准 52 张牌，无 Joker。
 * 牌面值用数字表示（2..14，Ace=14）以便于顺子检测与牌力比较；
 * 花色用字符串字面量联合类型，编译器即可排除 Joker/非法花色。
 *
 * 权威规格：docs/01-engine-spec.md §7（标准 52 张、无 Joker）。
 */

/** 四种标准花色。 */
export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export type Suit = (typeof SUITS)[number];

/** 2–A：Ace=14，King=13，…，2=2。 */
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Rank = (typeof RANKS)[number];

/** 常用牌面常量，提升语义可读性。 */
export const ACE = 14;
export const KING = 13;
export const QUEEN = 12;
export const JACK = 11;
export const TEN = 10;

/** 规范码中牌面值字母（2..9 直接用数字，10=T，J/Q/K/A 为字母）。 */
const CODE_BY_RANK: Record<number, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

const SUIT_CODE: Record<Suit, string> = {
  spades: "s",
  hearts: "h",
  diamonds: "d",
  clubs: "c",
};

const CODE_TO_RANK: Record<string, number> = Object.fromEntries(
  RANKS.map((rank): [string, number] => [CODE_BY_RANK[rank], rank]),
);

const CODE_TO_SUIT: Record<string, Suit> = Object.fromEntries(
  SUITS.map((suit): [string, Suit] => [SUIT_CODE[suit], suit]),
);

/** 一张不可变扑克牌：花色 + 牌面值（2..14，Ace=14）。 */
export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

/**
 * 构造一张牌。由于 `Suit`/`Rank` 已是窄类型，编译器层面即保证合法；
 * 从不可信来源拿值时应先用 {@link isCard} 校验。
 */
export function createCard(suit: Suit, rank: Rank): Card {
  return { suit, rank };
}

/** 运行时校验一个未知值是否为合法 Card（rank ∈ [2,14] 且 suit ∈ 四种花色）。 */
export function isCard(value: unknown): value is Card {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const rank = candidate.rank;
  return (
    typeof rank === "number" &&
    Number.isInteger(rank) &&
    rank >= 2 &&
    rank <= 14 &&
    typeof candidate.suit === "string" &&
    (SUITS as readonly string[]).includes(candidate.suit)
  );
}

/** 规范码：牌面值字母（A、K、Q、J、T、9…2）+ 花色小写首字母，例如 "As"、"Td"。 */
export function cardCode(card: Card): string {
  return `${CODE_BY_RANK[card.rank]}${SUIT_CODE[card.suit]}`;
}

/** `cardCode` 的逆操作；非法代码抛错。 */
export function parseCard(code: string): Card {
  if (code.length !== 2) {
    throw new Error(`非法牌名：${code}；应为两位，如 "As"、"Td"`);
  }
  const rank = CODE_TO_RANK[code[0]!.toUpperCase()];
  const suit = CODE_TO_SUIT[code[1]!.toLowerCase()];
  if (rank === undefined || suit === undefined) {
    throw new Error(`非法牌名：${code}`);
  }
  return { suit, rank: rank as Rank };
}

/** 两张牌是否相等（花色与牌面值相同）。 */
export function cardsEqual(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

/** 唯一标识键（与 {@link cardCode} 一致），供去重 / Set 使用。 */
export function cardKey(card: Card): string {
  return cardCode(card);
}
