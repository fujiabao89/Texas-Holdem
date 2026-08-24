/**
 * LegalActions 计算门面（TEX-14）。
 *
 * 输入完整 GameState 与座位号，输出该座位当前合法动作。Engine 是唯一合法动作来源；UI/AI 不得自行推断。
 *
 * 权威规格：docs/01-engine-spec.md §5.2。
 */
import type { GameState } from "../model/hand";
import type { LegalActions } from "../model/legal";
import { computeLegalActions } from "./betting";

/** 计算某座位的合法动作；非下注阶段或非法座位抛错。 */
export function computeLegalActionsForSeat(state: GameState, seatIndex: number): LegalActions {
  if (state.phase !== state.street || state.currentActor !== seatIndex) {
    throw new Error(`computeLegalActionsForSeat: 当前不是 ${seatIndex} 的行动回合（actor=${state.currentActor}）`);
  }
  const player = state.seats.find((s) => s.seatIndex === seatIndex);
  if (!player) throw new Error(`computeLegalActionsForSeat: 无座位 ${seatIndex}`);
  return computeLegalActions(
    {
      currentBet: state.currentBet,
      lastFullRaiseSize: state.lastFullRaiseSize,
      hasFullBetOrRaise: state.hasFullBetOrRaise,
      bigBlind: state.bigBlind,
    },
    {
      streetBet: player.streetBet,
      chips: player.chips,
      hasActedThisStreet: player.hasActedThisStreet,
      lastDecisionBet: player.lastDecisionBet,
      lastDecisionRaiseSize: player.lastDecisionRaiseSize,
    },
  );
}
