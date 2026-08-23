/**
 * 当前玩家的合法动作集合（TEX-14）。
 *
 * Engine 是唯一合法动作来源：UI 与 AI 不得自行推断（§2.1 / §5.2）。
 * 金额语义：`betTo` / `raiseTo` 均为本街目标总投入（§5.1）；不适用字段为 `null`。
 *
 * 权威规格：docs/01-engine-spec.md §5.2。
 */
export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** 跟注所需金额 = max(0, currentBet - streetBet)；`canCall` 为真时 >0。 */
  readonly callAmount: number;
  /** 当前无人下注时可下注；`canBet` 为真时 `target` 至少为 BB。 */
  readonly canBet: boolean;
  readonly minBetTo: number | null;
  /** 仅当能完成**完整**加注时为真；Short All-in 绝不伪装为 Raise（§5.2）。 */
  readonly canRaise: boolean;
  readonly minRaiseTo: number | null;
  /** 完整加注上限 = streetBet + chips（§5.2 强调其不是 Short All-in 可按普通 Raise 提交）。 */
  readonly maxRaiseTo: number;
  /** `chips>0` 且全下会改变本街投入；`allInTo === currentBet` 即是一次跟注，不当作独立 ALL_IN。 */
  readonly canAllIn: boolean;
  readonly allInTo: number;
}
