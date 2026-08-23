/**
 * 行动时限与 Time Bank 纯领域模型（TEX-15）。
 *
 * 本模块只建模「时限档位 / Time Bank 总额 / 单次消耗」的领域规则，不做任何调度、倒计时、
 * WebSocket 或自动动作。实际倒计时、超时 Auto Check/Fold 与断线计时均属 game-server Scheduler
 * （规格 §12 / §13；《总规划》§3.1）。
 *
 * 规则（规格 §12 / §20 裁决）：
 * - `actionTime` 只允许 15 / 20 / 30 / 45 / 60 秒或 `UNLIMITED`，默认 30 秒；
 * - `timeBank` 只允许 0 / 30 / 60 / 120 秒，默认 60 秒；
 * - `UNLIMITED` 时 `timeBank` 必须为 0（不限时无行动超时、不可使用 Time Bank）；
 * - 单次 Time Bank 最多延长/扣除 30 秒，且每个行动机会最多成功一次。
 *
 * 权威规格：docs/01-engine-spec.md §12、§20、§13。
 */

/** 有限时限档位（秒）。 */
export const ACTION_TIME_SECONDS = [15, 20, 30, 45, 60] as const;
export type ActionTimeSeconds = (typeof ACTION_TIME_SECONDS)[number];

/** `actionTime` 完整取值：有限档位或 `UNLIMITED`。 */
export type ActionTime = ActionTimeSeconds | "UNLIMITED";

/** Time Bank 总额档位（秒）。 */
export const TIME_BANK_SECONDS = [0, 30, 60, 120] as const;
export type TimeBankSeconds = (typeof TIME_BANK_SECONDS)[number];

/** 单次 Time Bank 最多消耗的秒数（规格 §12 / §20 裁决 #1）。 */
export const TIME_BANK_STEP_SECONDS = 30;

/** 各字段默认值（规格 §12）。 */
export const DEFAULT_ACTION_TIME: ActionTime = 30;
export const DEFAULT_TIME_BANK: TimeBankSeconds = 60;

/** 行动时限配置（TournamentConfig 的子集）。 */
export interface ActionTimerConfig {
  readonly actionTime: ActionTime;
  readonly timeBank: TimeBankSeconds;
}

/** 校验行动时限配置；非法抛错（供 validateTournamentConfig 复用，Engine 是唯一规则来源）。 */
export function validateActionTimerConfig(config: ActionTimerConfig): void {
  if (
    config.actionTime !== "UNLIMITED" &&
    !(ACTION_TIME_SECONDS as readonly number[]).includes(config.actionTime)
  ) {
    throw new Error(`validateActionTimerConfig: actionTime 非法 ${config.actionTime}`);
  }
  if (!(TIME_BANK_SECONDS as readonly number[]).includes(config.timeBank)) {
    throw new Error(`validateActionTimerConfig: timeBank 非法 ${config.timeBank}`);
  }
  if (config.actionTime === "UNLIMITED" && config.timeBank !== 0) {
    throw new Error("validateActionTimerConfig: UNLIMITED 时 timeBank 必须为 0");
  }
}

/** Time Bank 状态：剩余秒数与「本行动机会是否已消耗」。 */
export interface TimeBankState {
  /** 剩余可用秒数（≥0，整数）。 */
  readonly secondsRemaining: number;
  /** 本行动机会是否已成功使用过 Time Bank。 */
  readonly usedThisOpportunity: boolean;
}

/** 从配置构造初始 Time Bank 状态。 */
export function initialTimeBankState(timeBank: TimeBankSeconds): TimeBankState {
  return { secondsRemaining: timeBank, usedThisOpportunity: false };
}

/**
 * 尝试消耗一次 Time Bank：若本行动机会已用过、或余额为 0，返回 null（不可用）；
 * 否则扣减 `min(TIME_BANK_STEP_SECONDS, secondsRemaining)` 并标记已使用。
 */
export function consumeTimeBank(state: TimeBankState): TimeBankState | null {
  if (state.usedThisOpportunity || state.secondsRemaining <= 0) {
    return null;
  }
  const deduct = Math.min(TIME_BANK_STEP_SECONDS, state.secondsRemaining);
  return {
    secondsRemaining: state.secondsRemaining - deduct,
    usedThisOpportunity: true,
  };
}

/** 进入新行动机会时复位「本机会已使用」标记（余额保留）。 */
export function resetTimeBankOpportunity(state: TimeBankState): TimeBankState {
  return { ...state, usedThisOpportunity: false };
}
