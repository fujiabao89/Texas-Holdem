/**
 * 玩家在单局内的状态（TEX-14）。
 *
 * `streetBet`（本街投入）与 `handContribution`（本手总投入）分离：前者驱动跟注/加注，
 * 后者是 Side Pot 分层的依据（§4.3 / §9）。
 * `lastDecisionBet` / `lastDecisionRaiseSize` 记录该玩家上一次**主动决定**时面对的
 * `currentBet` 与 `lastFullRaiseSize`，用于按累积增量判定加注权重开（§8.3）。
 *
 * 权威规格：docs/01-engine-spec.md §4.3、§8.3。
 */
import type { Card } from "../cards";
import type { ParticipantKind } from "./type";

export interface PlayerState {
  readonly seatIndex: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  /** 剩余筹码（≥0，整数）。 */
  readonly chips: number;
  /** 底牌（发完 2 张后满 2；0 或 2）。服务器内部持面。 */
  readonly holeCards: readonly Card[];
  /** 本街已投入金额。 */
  readonly streetBet: number;
  /** 本手累计投入（含前面各街）。 */
  readonly handContribution: number;
  readonly folded: boolean;
  readonly isAllIn: boolean;
  /** 本街是否已作出一次主动行动（check/call/bet/raise/all-in/fold 均算）。 */
  readonly hasActedThisStreet: boolean;
  /** 上次主动决定时面对的 `currentBet`。 */
  readonly lastDecisionBet: number;
  /** 上次主动决定时的 `lastFullRaiseSize`。 */
  readonly lastDecisionRaiseSize: number;
}
