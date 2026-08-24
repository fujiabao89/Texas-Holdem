/**
 * 已知失败 seed 回归集（TEX-16）。
 *
 * 历史上由失败报告确认的 seed：引擎修复后必须持续通过（回归保护），并随
 * `pnpm test:sim -- --seed <n> --games 1` 可独立重放（docs/06-testing-strategy.md §3.4/§5）。
 * 当前为空集：模拟器尚未发现引擎失败；首个失败 seed 经（人工或后续任务自动）缩减确认后加入。
 */
export const KNOWN_FAILURE_SEEDS: readonly number[] = [];
