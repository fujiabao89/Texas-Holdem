/**
 * 失败报告与现场保留（TEX-16）。
 *
 * 任何失败（不变量违反、引擎错误、Watchdog 越界、覆盖空洞）都封装为
 * `SimulationFailure`，携带可直接重放的 seed、最小场景 fixture、失败类别、
 * 完整 Action/Event 轨迹、失败时状态与统计摘要，序列化写入失败产物目录
 * （docs/06-testing-strategy.md §5「输出」）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlindMode, PokerEvent } from "../../../packages/poker-engine/src/index";
import type { TournamentState } from "../../../packages/poker-engine/src/index";
import type { SimulatorScenario } from "../random-hands/scenario";

export type SimulationFailureCategory =
  | "invariant-violation"
  | "engine-error"
  | "watchdog-action-limit"
  | "watchdog-time-limit"
  | "watchdog-hand-stuck"
  | "coverage-gap";

/** 模拟器版本：失败产物中记录，用于关联产物格式与代码版本。 */
export const SIMULATOR_VERSION = "tex-16";

/** 失败前记录的动作轨迹（有界：watchdog 保证 ≤50,000 条）。 */
export interface RecordedAction {
  readonly hand: number;
  readonly street: string;
  readonly seat: number;
  readonly type: string;
  readonly amount: number | null;
}

export interface SimulationFailureArgs {
  readonly category: SimulationFailureCategory;
  readonly message: string;
  /** 出错的锦标赛 seed（coverage-gap 无单场 seed 时为 null）。 */
  readonly seed: number | null;
  readonly scenario: SimulatorScenario | null;
  readonly actions?: readonly RecordedAction[];
  readonly events?: readonly PokerEvent[];
  readonly state?: TournamentState | null;
  readonly stats?: Record<string, number> | null;
  /** 覆盖空洞类别（仅 coverage-gap）。 */
  readonly missingCategories?: readonly string[];
  /** 关联的候选提交（可空；由 CLI 传入）。 */
  readonly gitSha?: string;
  /** 运行时的强制 Blind Mode（Nightly 逐模式批次）；重放命令必须带上它才能复现同一场景。 */
  readonly forcedBlindMode?: BlindMode;
}

export class SimulationFailure extends Error {
  readonly category: SimulationFailureCategory;
  readonly seed: number | null;
  readonly scenario: SimulatorScenario | null;
  readonly actions: readonly RecordedAction[];
  readonly events: readonly PokerEvent[];
  readonly state: TournamentState | null;
  readonly stats: Record<string, number> | null;
  readonly missingCategories: readonly string[];
  readonly gitSha: string | null;
  readonly forcedBlindMode: BlindMode | null;

  constructor(args: SimulationFailureArgs) {
    super(args.message);
    this.name = "SimulationFailure";
    this.category = args.category;
    this.seed = args.seed;
    this.scenario = args.scenario;
    this.actions = args.actions ?? [];
    this.events = args.events ?? [];
    this.state = args.state ?? null;
    this.stats = args.stats ?? null;
    this.missingCategories = args.missingCategories ?? [];
    this.gitSha = args.gitSha ?? null;
    this.forcedBlindMode = args.forcedBlindMode ?? null;
  }

  /**
   * 100% 重放命令（docs/06 §5：同一 seed 必须完全重放）。
   * 强制 Blind Mode 的批次（Nightly）必须带 `--blind-mode`：强制模式会改变场景
   * 派生的随机流，仅凭 seed 重放会得到不同场景，而非仅模式不同。
   */
  replayCommand(): string | null {
    if (this.seed === null) return null;
    const modePart = this.forcedBlindMode === null ? "" : ` --blind-mode ${this.forcedBlindMode}`;
    return `pnpm test:sim -- --seed ${this.seed} --games 1${modePart}`;
  }
}

/** JSON 安全的失败报告（冻结对象经结构化克隆拷贝；不含时间戳，保证产物确定性）。 */
export function serializeFailure(failure: SimulationFailure): Record<string, unknown> {
  return {
    simulatorVersion: SIMULATOR_VERSION,
    category: failure.category,
    message: failure.message,
    seed: failure.seed,
    replayCommand: failure.replayCommand(),
    gitSha: failure.gitSha,
    forcedBlindMode: failure.forcedBlindMode,
    scenario: failure.scenario,
    actionCount: failure.actions.length,
    actions: failure.actions,
    eventCount: failure.events.length,
    events: failure.events,
    state: failure.state,
    statsSummary: failure.stats,
    missingCategories: failure.missingCategories,
  };
}

/** 写入失败产物 JSON；返回文件路径。目录按需创建。 */
export function writeFailureArtifact(
  dir: string,
  failure: SimulationFailure,
  fileSuffix = "",
): string {
  mkdirSync(dir, { recursive: true });
  const seedPart = failure.seed === null ? "noseed" : `seed${failure.seed}`;
  const file = join(dir, `failure-${seedPart}-${failure.category}${fileSuffix}.json`);
  writeFileSync(file, `${JSON.stringify(serializeFailure(failure), null, 2)}\n`, "utf8");
  return file;
}

/** 控制台失败报告（人类可读；完整细节见产物 JSON）。 */
export function formatFailureReport(failure: SimulationFailure): string {
  const lines = [
    "[tex-sim] RESULT: FAILED",
    `[tex-sim] 失败类别：${failure.category}`,
    `[tex-sim] 失败原因：${failure.message}`,
  ];
  if (failure.seed !== null) {
    lines.push(`[tex-sim] seed=${failure.seed}；重放：${failure.replayCommand()}`);
  }
  if (failure.scenario) {
    lines.push(`[tex-sim] 场景：${failure.scenario.label}（${failure.scenario.playerCount} 人 / ${failure.scenario.stackDepth} / ${failure.scenario.blindMode} / ${failure.scenario.agentStyle}）`);
  }
  if (failure.actions.length > 0) {
    lines.push(`[tex-sim] 已执行动作：${failure.actions.length} 个（完整轨迹见失败产物）`);
  }
  if (failure.missingCategories.length > 0) {
    lines.push(`[tex-sim] 覆盖空洞：${failure.missingCategories.join(", ")}`);
  }
  return lines.join("\n");
}
