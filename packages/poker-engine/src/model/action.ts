/**
 * 玩家动作（TEX-14）。
 *
 * 金额语义（§5.1 / §8.6）：
 * - `bet`/`raise` 的 `amount` 为**本街目标总投入**（`betTo` / `raiseTo`）；Engine 只接受最终合法整数金额。
 * - `call` 不带自选金额：投入 `min(callAmount, chips)`。
 * - `all-in` 必须投入该玩家全部剩余筹码，`amount` 字段忽略。
 * - `fold`/`check` 不带金额。
 * 所有筹码金额均为非负整数；非法金额拒绝且状态不变。
 *
 * 权威规格：docs/01-engine-spec.md §5.1、§8.6。
 */
import type { ActionSource, ActionType } from "./type";

export interface PlayerAction {
  readonly type: ActionType;
  readonly seatIndex: number;
  /** `bet`/`raise` 使用：本街目标总投入（`betTo`/`raiseTo`）。 */
  readonly amount?: number;
  readonly source: ActionSource;
}
