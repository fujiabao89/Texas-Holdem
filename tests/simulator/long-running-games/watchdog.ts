/**
 * Liveness Watchdog（TEX-16）。
 *
 * 按 docs/06-testing-strategy.md §5【工程基线】：单场超过 50,000 个 Action、
 * 30 秒测试进程时间，或连续 1,000 次状态转移未完成一手牌，均按 Liveness Failure
 * 失败并保留现场（由 runner 捕获后写入失败产物）。
 *
 * 阈值可注入（测试用小阈值/假时钟验证触发逻辑，不使用 sleep）；Release 前冻结默认值。
 */
export interface WatchdogThresholds {
  /** 单场锦标赛最大 Action 数。 */
  readonly maxActionsPerTournament: number;
  /** 单场锦标赛最大进程耗时（毫秒）。 */
  readonly maxElapsedMsPerTournament: number;
  /** 完成一手牌前允许的最大连续状态转移数。 */
  readonly maxTransitionsPerHand: number;
}

/** 规格默认阈值（docs/06-testing-strategy.md §5）。 */
export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  maxActionsPerTournament: 50_000,
  maxElapsedMsPerTournament: 30_000,
  maxTransitionsPerHand: 1_000,
};

export type WatchdogBreach = "action-limit" | "time-limit" | "hand-stuck";

export class WatchdogFailure extends Error {
  constructor(
    readonly breach: WatchdogBreach,
    message: string,
  ) {
    super(message);
    this.name = "WatchdogFailure";
  }
}

export interface Watchdog {
  /** 记录一次状态转移（startNextHand / applyAction / recordElapsedTime）。 */
  noteTransition(): void;
  /** 记录一次玩家 Action。 */
  noteAction(): void;
  /** 一手牌完成（hand_end）后重置「卡手」计数。 */
  noteHandCompleted(): void;
  /** 检查全部阈值；越界抛 {@link WatchdogFailure}。 */
  check(): void;
}

export function createWatchdog(
  thresholds: WatchdogThresholds = DEFAULT_WATCHDOG_THRESHOLDS,
  now: () => number = () => performance.now(),
): Watchdog {
  let actions = 0;
  let transitionsInCurrentHand = 0;
  const startMs = now();

  return {
    noteTransition(): void {
      transitionsInCurrentHand++;
    },
    noteAction(): void {
      actions++;
    },
    noteHandCompleted(): void {
      transitionsInCurrentHand = 0;
    },
    check(): void {
      if (actions > thresholds.maxActionsPerTournament) {
        throw new WatchdogFailure(
          "action-limit",
          `单场 Action 数 ${actions} 超过上限 ${thresholds.maxActionsPerTournament}`,
        );
      }
      const elapsed = now() - startMs;
      if (elapsed > thresholds.maxElapsedMsPerTournament) {
        throw new WatchdogFailure(
          "time-limit",
          `单场耗时 ${elapsed.toFixed(0)}ms 超过上限 ${thresholds.maxElapsedMsPerTournament}ms`,
        );
      }
      if (transitionsInCurrentHand > thresholds.maxTransitionsPerHand) {
        throw new WatchdogFailure(
          "hand-stuck",
          `连续 ${transitionsInCurrentHand} 次状态转移未完成一手牌（上限 ${thresholds.maxTransitionsPerHand}）`,
        );
      }
    },
  };
}
