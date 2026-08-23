/**
 * 锦标赛纯规则（TEX-15）。
 *
 * 本模块提供：唯一配置校验 `validateTournamentConfig`、盲注等级计算（固定/按时间/按手数）、
 * 后续 Dealer 选择。不依赖 engine/pots/events，纯函数可单测。
 *
 * 规则要点（规格 §12 / §14 / §17）：
 * - 盲注只在两手之间变更；允许下降；每 Level 独立校验（SB<BB），不继承上一级最小加注（每手重算）。
 * - 按手数升盲：每 5 Hands，第 6 Hand 用新等级（handNumber 从 1 起，等级覆盖区间按累计手数）。
 * - 首手 Dealer 由注入 RNG 从 ACTIVE、chips>0、非撤回座位选（见 rules/blinds selectDealer）；
 *   后续 Dealer 顺时针移动并跳过非参赛者。
 *
 * 权威规格：docs/01-engine-spec.md §12。
 */
import type {
  BlindLevel,
  BlindMode,
  TournamentConfig,
  TournamentConfigInput,
} from "../model/tournament";
import type { ActionTime, TimeBankSeconds } from "../timer/action-timer";
import {
  DEFAULT_ACTION_TIME,
  DEFAULT_TIME_BANK,
  validateActionTimerConfig,
} from "../timer/action-timer";
import { seatsClockwise } from "./blinds";

/** 唯一配置校验来源；非法抛错，合法返回冻结后的规范化配置（补缺省值）。 */
export function validateTournamentConfig(input: TournamentConfigInput): TournamentConfig {
  const actionTime: ActionTime = input.actionTime ?? DEFAULT_ACTION_TIME;
  const timeBank: TimeBankSeconds = input.timeBank ?? DEFAULT_TIME_BANK;
  const config: TournamentConfig = {
    maxPlayers: input.maxPlayers,
    startingStack: input.startingStack,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    blindMode: input.blindMode,
    blindStructure: input.blindStructure,
    actionTime,
    timeBank,
  };

  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 2 || config.maxPlayers > 10) {
    throw new Error(`validateTournamentConfig: maxPlayers 必须为 2–10 的整数，收到 ${config.maxPlayers}`);
  }
  if (!Number.isInteger(config.startingStack) || config.startingStack <= 0) {
    throw new Error(`validateTournamentConfig: startingStack 必须为正整数，收到 ${config.startingStack}`);
  }
  if (!Number.isInteger(config.smallBlind) || config.smallBlind <= 0) {
    throw new Error(`validateTournamentConfig: smallBlind 必须为正整数，收到 ${config.smallBlind}`);
  }
  if (!Number.isInteger(config.bigBlind) || config.bigBlind <= 0) {
    throw new Error(`validateTournamentConfig: bigBlind 必须为正整数，收到 ${config.bigBlind}`);
  }
  if (config.smallBlind >= config.bigBlind) {
    throw new Error(`validateTournamentConfig: smallBlind ${config.smallBlind} 必须小于 bigBlind ${config.bigBlind}`);
  }

  validateActionTimerConfig({ actionTime: config.actionTime, timeBank: config.timeBank });
  validateBlindModeAndStructure(config);

  return Object.freeze(config);
}

function validateBlindModeAndStructure(config: TournamentConfig): void {
  if (!["fixed", "time", "hands"].includes(config.blindMode)) {
    throw new Error(`validateTournamentConfig: blindMode 非法 ${String(config.blindMode)}`);
  }
  const structure = config.blindStructure;
  if (!Array.isArray(structure) || structure.length === 0) {
    throw new Error("validateTournamentConfig: blindStructure 必须为非空数组");
  }
  for (let i = 0; i < structure.length; i++) {
    const level = structure[i]!;
    if (!Number.isInteger(level.smallBlind) || level.smallBlind <= 0) {
      throw new Error(`validateTournamentConfig: 等级 ${i} 的 smallBlind 非法 ${level.smallBlind}`);
    }
    if (!Number.isInteger(level.bigBlind) || level.bigBlind <= 0) {
      throw new Error(`validateTournamentConfig: 等级 ${i} 的 bigBlind 非法 ${level.bigBlind}`);
    }
    if (level.smallBlind >= level.bigBlind) {
      throw new Error(`validateTournamentConfig: 等级 ${i} 的 SB < BB 不成立`);
    }
    if (config.blindMode === "hands") {
      if (!Number.isInteger(level.hands) || level.hands! <= 0) {
        throw new Error(`validateTournamentConfig: hands 模式等级 ${i} 需 positive hands`);
      }
    }
    if (config.blindMode === "time") {
      if (!Number.isInteger(level.durationSeconds) || level.durationSeconds! <= 0) {
        throw new Error(`validateTournamentConfig: time 模式等级 ${i} 需 positive durationSeconds`);
      }
    }
  }
  // 首级须与 SB/BB 一致（初始盲注 = 首等级）。
  const first = structure[0]!;
  if (first.smallBlind !== config.smallBlind || first.bigBlind !== config.bigBlind) {
    throw new Error("validateTournamentConfig: blindStructure[0] 须与 smallBlind/bigBlind 一致");
  }
  if (config.blindMode === "fixed" && structure.length !== 1) {
    throw new Error("validateTournamentConfig: fixed 模式 blindStructure 须恰好 1 级");
  }
}

/**
 * 计算指定手/时间的盲注等级索引（0-based）。
 * - fixed：恒为 0。
 * - hands：按累计手数；例如每级 5 手，第 6 手进入下一级。
 * - time：按累计秒数。
 */
export function computeBlindLevelIndex(
  mode: BlindMode,
  structure: readonly BlindLevel[],
  handNumber: number,
  elapsedSeconds: number,
): number {
  if (structure.length === 0) throw new Error("computeBlindLevelIndex: 无盲注等级");
  if (mode === "fixed") return 0;
  if (mode === "hands") {
    let cumulative = 0;
    for (let i = 0; i < structure.length; i++) {
      cumulative += structure[i]!.hands ?? 0;
      if (handNumber <= cumulative) return i;
    }
    return structure.length - 1;
  }
  let cumulative = 0;
  for (let i = 0; i < structure.length; i++) {
    cumulative += structure[i]!.durationSeconds ?? 0;
    if (elapsedSeconds <= cumulative) return i;
  }
  return structure.length - 1;
}

/** 解析某等级对应的盲注。 */
export function resolveBlindLevel(
  structure: readonly BlindLevel[],
  index: number,
): { readonly smallBlind: number; readonly bigBlind: number } {
  const level = structure[index];
  if (!level) throw new Error(`resolveBlindLevel: 越界等级 ${index}`);
  return { smallBlind: level.smallBlind, bigBlind: level.bigBlind };
}

/**
 * 后续 Dealer：从当前 Dealer 顺时针移动到下一仍在参赛的座位（跳过 WITHDRAWN/ELIMINATED/空位）。
 * `activeSeats` 须按 seatIndex 升序或任意顺序；返回顺时针下一座位。仅剩一名时返回其自身。
 */
export function nextTournamentDealer(currentDealer: number, activeSeats: readonly number[]): number {
  const ordered = seatsClockwise(activeSeats, currentDealer);
  for (const seat of ordered) {
    if (seat !== currentDealer) return seat;
  }
  return currentDealer;
}

/** 同手淘汰排序候选：需要「手开始时 stack」以决定名次。 */
export interface EliminationCandidate {
  readonly seatIndex: number;
  readonly handStartChips: number;
}

/**
 * 同手多人淘汰的稳定排序（§12）：手开始时 stack 较高者排名更高（名次数字更小）；
 * 相同则 `seatIndex` 升序作为稳定展示顺序。返回排序后的 seatIndex。
 */
export function sortEliminationGroup(players: readonly EliminationCandidate[]): number[] {
  return [...players]
    .sort((a, b) => b.handStartChips - a.handStartChips || a.seatIndex - b.seatIndex)
    .map((p) => p.seatIndex);
}
