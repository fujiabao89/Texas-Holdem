/**
 * 七选五 Hand Evaluator（TEX-13）。
 *
 * 输入 5–7 张互不重复的 Card，输出最佳 5 张牌的：牌型类别、可排序比较键与 `bestFiveCards`。
 * 采用枚举全部 `C(n,5)` 组合取最强者，保证正确性优先于性能。
 *
 * 牌型强度（低 → 高）：High Card < One Pair < Two Pair < Three of a Kind < Straight <
 * Flush < Full House < Four of a Kind < Straight Flush。Royal Flush 是最高 Straight Flush，不单列。
 *
 * 权威规格：docs/01-engine-spec.md §10（Kicker、A2345、Board Plays、可排序比较键）。
 */
import { cardCode, isCard } from "./card";
import type { Card } from "./card";

/** 牌型类别，按强弱升序编号（低 → 高）。Royal Flush 不单列。 */
export enum HandRank {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

const HAND_RANK_NAMES: Record<HandRank, string> = {
  [HandRank.HighCard]: "High Card",
  [HandRank.OnePair]: "One Pair",
  [HandRank.TwoPair]: "Two Pair",
  [HandRank.ThreeOfAKind]: "Three of a Kind",
  [HandRank.Straight]: "Straight",
  [HandRank.Flush]: "Flush",
  [HandRank.FullHouse]: "Full House",
  [HandRank.FourOfAKind]: "Four of a Kind",
  [HandRank.StraightFlush]: "Straight Flush",
};

/** 人类可读的牌型名称。 */
export function handRankName(rank: HandRank): string {
  return HAND_RANK_NAMES[rank];
}

/** 一次评估结果：牌型、组成牌型的 5 张、可排序比较键。 */
export interface HandEvaluation {
  readonly rank: HandRank;
  /** 精确组成该牌型的 5 张牌（供 Showdown 高亮）。 */
  readonly bestFiveCards: readonly Card[];
  /** 可排序比较键：`[rank, ...决胜序列]`；按字典序比较即胜负。 */
  readonly comparisonKey: readonly number[];
}

/** 输入非法：牌数不在 5–7。 */
export class InvalidHandCountError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`evaluateHand: 需要 5–7 张牌，实际收到 ${count} 张`);
    this.name = "InvalidHandCountError";
    this.count = count;
  }
}

/** 输入非法：存在无效 Card（rank/suit 越界）。 */
export class InvalidCardError extends Error {
  constructor(card: unknown) {
    const desc = typeof card === "string" ? card : JSON.stringify(card);
    super(`evaluateHand: 非法牌 ${desc}`);
    this.name = "InvalidCardError";
  }
}

/** 输入非法：存在重复牌。 */
export class DuplicateCardError extends Error {
  constructor(card: Card) {
    super(`evaluateHand: 重复牌 ${cardCode(card)}`);
    this.name = "DuplicateCardError";
  }
}

/**
 * 评估 5–7 张牌并返回最佳 5 张牌的评估结果。
 * 校验牌数与唯一性；不支持的牌数、重复牌、无效 Card 均抛明确错误。
 */
export function evaluateHand(cards: readonly Card[]): HandEvaluation {
  validateInput(cards);
  const subsets = combinationsOfFive(cards);
  let best = evaluateFive(subsets[0]);
  for (let i = 1; i < subsets.length; i++) {
    const current = evaluateFive(subsets[i]);
    if (compareEvaluations(current, best) > 0) {
      best = current;
    }
  }
  return best;
}

/** 稳定胜负比较：返回 1（a 胜 b）/ -1（a 负 b）/ 0（平）。 */
export function compareEvaluations(a: HandEvaluation, b: HandEvaluation): -1 | 0 | 1 {
  const ka = a.comparisonKey;
  const kb = b.comparisonKey;
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  if (ka.length !== kb.length) return ka.length > kb.length ? 1 : -1;
  return 0;
}

/** 以双方视角返回胜 / 负 / 平（用于后续按 Pot 决胜）。 */
export function decideOutcome(hand: HandEvaluation, opponent: HandEvaluation): "win" | "lose" | "tie" {
  const cmp = compareEvaluations(hand, opponent);
  return cmp > 0 ? "win" : cmp < 0 ? "lose" : "tie";
}

function validateInput(cards: readonly Card[]): void {
  if (cards.length < 5 || cards.length > 7) {
    throw new InvalidHandCountError(cards.length);
  }
  const seen = new Set<string>();
  for (const card of cards) {
    if (!isCard(card)) {
      throw new InvalidCardError(card);
    }
    const key = cardCode(card);
    if (seen.has(key)) {
      throw new DuplicateCardError(card);
    }
    seen.add(key);
  }
}

/** 枚举全部 `C(n,5)` 组合（n ∈ [5,7]，最多 21 种）。 */
function combinationsOfFive(cards: readonly Card[]): Card[][] {
  const n = cards.length;
  const result: Card[][] = [];
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            result.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
          }
        }
      }
    }
  }
  return result;
}

/** 评估一张恰为 5 张的手牌（内部使用；输入已保证长度 5、互不重复、合法）。 */
function evaluateFive(cards: readonly Card[]): HandEvaluation {
  const ranks = cards.map((card) => card.rank);
  const isFlush = cards.every((card) => card.suit === cards[0]!.suit);
  const straightHigh = straightHighValue(ranks);

  const frequency = new Map<number, number>();
  for (const rank of ranks) {
    frequency.set(rank, (frequency.get(rank) ?? 0) + 1);
  }
  // 按 (出现次数降序, 牌值降序) 排序，作为该牌型的关键排序依据。
  const groups = [...frequency.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts = groups.map(([, count]) => count);

  let rank: HandRank;
  let tiebreakers: number[];

  if (isFlush && straightHigh !== null) {
    rank = HandRank.StraightFlush;
    tiebreakers = [straightHigh];
  } else if (counts[0] === 4) {
    rank = HandRank.FourOfAKind;
    tiebreakers = [groups[0]![0], groups[1]![0]];
  } else if (counts[0] === 3 && counts[1] === 2) {
    rank = HandRank.FullHouse;
    tiebreakers = [groups[0]![0], groups[1]![0]];
  } else if (isFlush) {
    rank = HandRank.Flush;
    tiebreakers = descendingRanks(ranks);
  } else if (straightHigh !== null) {
    rank = HandRank.Straight;
    tiebreakers = [straightHigh];
  } else if (counts[0] === 3) {
    rank = HandRank.ThreeOfAKind;
    tiebreakers = [groups[0]![0], groups[1]![0], groups[2]![0]];
  } else if (counts[0] === 2 && counts[1] === 2) {
    rank = HandRank.TwoPair;
    tiebreakers = [groups[0]![0], groups[1]![0], groups[2]![0]];
  } else if (counts[0] === 2) {
    rank = HandRank.OnePair;
    tiebreakers = [groups[0]![0], groups[1]![0], groups[2]![0], groups[3]![0]];
  } else {
    rank = HandRank.HighCard;
    tiebreakers = descendingRanks(ranks);
  }

  return {
    rank,
    bestFiveCards: [...cards],
    comparisonKey: [rank, ...tiebreakers],
  };
}

function descendingRanks(ranks: readonly number[]): number[] {
  return [...ranks].sort((a, b) => b - a);
}

/**
 * 顺子最高张：若 5 张不同牌面值构成顺子，返回最高张；否则 null。
 * A-2-3-4-5 是最低顺子（5-high），A 记为 14 但仍按 5 计数。
 */
function straightHighValue(ranks: readonly number[]): number | null {
  const uniq = [...new Set(ranks)];
  if (uniq.length !== 5) return null;
  const desc = descendingRanks(uniq);
  if (desc[0]! - desc[4]! === 4) return desc[0]!;
  if (desc[0] === 14 && desc[1] === 5 && desc[2] === 4 && desc[3] === 3 && desc[4] === 2) {
    return 5;
  }
  return null;
}
