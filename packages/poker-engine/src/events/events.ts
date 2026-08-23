/**
 * 领域事件（TEX-14 手级 + TEX-15 锦标赛级）。
 *
 * Engine 事件流为服务器**内部权威流**（可含底牌仅供 server 诊断与投影）；面向用户/客户的 `BURN_CARD`
 * 事件**绝不携带牌面**（任务硬性要求）。每个事件带自增 `sequence`，供「非法 Action 后 sequence 不变」断言。
 * 事件序列与状态转移严格一致（§14 / §16）。
 *
 * TEX-15 新增 `PLAYER_ELIMINATED` / `TOURNAMENT_FINISHED`（§14）。`timer/` 领域模型即可用类型见 src/timer。
 *
 * 权威规格：docs/01-engine-spec.md §12、§13、§14、§16、§17。
 */
import type { Card } from "../cards";
import type { ActionSource, ParticipantKind, Street, FinalStanding, PlacementRange } from "../model";

/** 公共事件基座：每个事件都有自增 `sequence`。 */
interface EventBase {
  readonly sequence: number;
}

/** 一手中参与者的公开信息（HAND_STARTED 载荷）。 */
export interface HandStartedSeat {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly chips: number;
}

export type PokerEvent =
  | (EventBase & {
      readonly type: "HAND_STARTED";
      readonly handNumber: number;
      readonly dealerSeat: number;
      readonly sbSeat: number;
      readonly bbSeat: number;
      readonly smallBlind: number;
      readonly bigBlind: number;
      readonly seats: readonly HandStartedSeat[];
    })
  | (EventBase & {
      readonly type: "BLIND_POSTED";
      readonly seatIndex: number;
      readonly blind: "small" | "big";
      /** 实际投入额。 */
      readonly amount: number;
      /** 动作后本街目标总投入。 */
      readonly toAmount: number;
    })
  | (EventBase & {
      readonly type: "DEAL_HOLE_CARD";
      readonly seatIndex: number;
      readonly card: Card;
      readonly holeNumber: 1 | 2;
    })
  | (EventBase & { readonly type: "BURN_CARD"; readonly street: Street }) // 无牌面
  | (EventBase & { readonly type: "FLOP_DEALT"; readonly cards: readonly Card[] })
  | (EventBase & { readonly type: "TURN_DEALT"; readonly card: Card })
  | (EventBase & { readonly type: "RIVER_DEALT"; readonly card: Card })
  | (EventBase & {
      readonly type: "PLAYER_FOLDED" | "PLAYER_CHECKED" | "PLAYER_CALLED" | "PLAYER_ALL_IN";
      readonly seatIndex: number;
      readonly source: ActionSource;
      /** 实际投入额。 */
      readonly amount: number;
      /** 动作后本街目标总投入。 */
      readonly toAmount: number;
    })
  | (EventBase & {
      readonly type: "PLAYER_BET" | "PLAYER_RAISED";
      readonly seatIndex: number;
      readonly source: ActionSource;
      /** 实际投入额。 */
      readonly amount: number;
      /** 动作后本街目标总投入（betTo / raiseTo）。 */
      readonly toAmount: number;
    })
  | (EventBase & {
      readonly type: "SHOWDOWN_STARTED";
      readonly communityCards: readonly Card[];
      readonly remainingPlayers: readonly number[];
    })
  | (EventBase & {
      readonly type: "PLAYER_REVEALED";
      readonly seatIndex: number;
      readonly cards: readonly Card[];
    })
  | (EventBase & {
      readonly type: "UNCALLED_BET_RETURNED";
      readonly seatIndex: number;
      readonly amount: number;
    })
  | (EventBase & {
      readonly type: "POT_AWARDED";
      readonly potIndex: number;
      readonly amount: number;
      readonly winners: readonly number[];
      readonly prizeBySeat: Readonly<Record<number, number>>;
      readonly eligiblePlayers: readonly number[];
    })
  | (EventBase & {
      readonly type: "PLAYER_ELIMINATED";
      /** 发生淘汰的手号。 */
      readonly handNumber: number;
      readonly seatIndex: number;
      readonly placementRange: PlacementRange;
      /** 同手淘汰组内的稳定展示序号（1-based；非实际淘汰先后）。 */
      readonly displayOrder: number;
    })
  | (EventBase & {
      readonly type: "PLAYER_WITHDRAWN";
      readonly seatIndex: number;
      /** 被没收的剩余筹码（计入 forfeitedChips，不赠与其他玩家）。 */
      readonly forfeitedChips: number;
    })
  | (EventBase & {
      readonly type: "TOURNAMENT_FINISHED";
      readonly championSeat: number | null;
      readonly finalStandings: readonly FinalStanding[];
    });
