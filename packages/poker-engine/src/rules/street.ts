/**
 * 街推进与发公共牌（TEX-14）。
 *
 * 标准发牌顺序：Burn ×1 → Flop ×3 → Burn ×1 → Turn ×1 → Burn ×1 → River ×1（§7）。
 * Burn 牌面是隐藏信息：Burn 事件只携带「发生了 Burn」，不携带牌面（§7 / §14）。
 *
 * 权威规格：docs/01-engine-spec.md §7、§17（牌堆守恒）。
 */
import type { Card } from "../cards";
import type { Street } from "../model/type";

/** 下一街（river 之后返回 null，进入 showdown）。 */
export function nextStreet(street: Street): Street | null {
  if (street === "preflop") return "flop";
  if (street === "flop") return "turn";
  if (street === "turn") return "river";
  return null;
}

/** 该街对应的公共牌张数。 */
export function communityCount(street: Street): number {
  if (street === "preflop") return 0;
  if (street === "flop") return 3;
  if (street === "turn") return 4;
  return 5;
}

export interface DealResult {
  readonly burn: Card;
  readonly cards: readonly Card[];
  readonly remaining: readonly Card[];
}

/** 烧 1 张再发 target 街的公共牌；返回燃牌、新公共牌与剩余牌堆。 */
export function burnAndDeal(deck: readonly Card[], target: Street): DealResult {
  const need = target === "flop" ? 3 : 1;
  const burn = deck[0]!;
  const cards = deck.slice(1, 1 + need);
  const remaining = deck.slice(1 + need);
  return { burn, cards, remaining };
}
