/**
 * 性能压测统计原语（TEX-29）。
 *
 * 纯函数、无副作用：百分位（nearest-rank）、时序列均值/均值比（Soak 末小时 vs
 * 稳态小时用）、比率与除零保护。压测报告与门禁评估都经这些原语计算，保证同一
 * 数字在「产物」与「门禁判定」之间可复核（docs/06-testing-strategy.md §10.1）。
 */
export const DEFAULT_QUANTILES = [0.5, 0.95, 0.99] as const;

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsError";
  }
}

/** nearest-rank 百分位：q ∈ (0,1]。空样本抛错（不允许把“没测到”当“达标”）。 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new StatsError(`percentile(${q}) requires at least 1 sample`);
  if (!(q > 0 && q <= 1)) throw new StatsError(`percentile q must be in (0,1], got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/** 有序样本（保留到达顺序）上的 p50/p95/p99 与均值/极值摘要。 */
export function describeLatencies(valuesMs: readonly number[]): {
  readonly count: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
} {
  if (valuesMs.length === 0) throw new StatsError("describeLatencies requires at least 1 sample");
  let sum = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const value of valuesMs) {
    sum += value;
    if (value < minMs) minMs = value;
    if (value > maxMs) maxMs = value;
  }
  return {
    count: valuesMs.length,
    meanMs: sum / valuesMs.length,
    minMs,
    maxMs,
    p50: percentile(valuesMs, 0.5),
    p95: percentile(valuesMs, 0.95),
    p99: percentile(valuesMs, 0.99),
  };
}

/** 算术均值（空抛错）。 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new StatsError("mean requires at least 1 sample");
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 有界窗口内子序列的均值（warmup/steady 窗口切分复用）。 */
export function windowMean(
  points: readonly { readonly tMs: number; readonly value: number }[],
  startMs: number,
  endMs: number,
): number {
  const selected: number[] = [];
  for (const point of points) {
    if (point.tMs >= startMs && point.tMs < endMs) selected.push(point.value);
  }
  return mean(selected);
}

/**
 * 稳态增长率门禁原语（docs/06 §10.1 Soak）：
 * `finalWindowMs` 末段均值 ≤ `baselineWindowMs` 首段均值 × `allowance` 判通过。
 * 任一段无样本抛错（不能以“没采到内存”当作“无增长”）。
 */
export function growthRatio(
  points: readonly { readonly tMs: number; readonly value: number }[],
  baselineStartMs: number,
  baselineEndMs: number,
  finalStartMs: number,
  finalEndMs: number,
): number {
  const baseline = windowMean(points, baselineStartMs, baselineEndMs);
  const final = windowMean(points, finalStartMs, finalEndMs);
  if (baseline === 0) throw new StatsError("growthRatio: baseline mean is zero; cannot ratio");
  return final / baseline;
}

/** 比率（percent 语义）：numerator/denominator；分母为 0 返回 null（= 无法判定）。 */
export function ratioOrNull(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** 时间起点相对的 warmup 结束毫秒（按比例切掉首段，避免冷启动扭曲门禁）。 */
export function warmupCutoffMs(
  runStartedAtMs: number,
  nowMs: number,
  warmupFraction: number,
): number {
  return runStartedAtMs + Math.floor((nowMs - runStartedAtMs) * warmupFraction);
}

/**
 * Soak 内存增长比（末窗口/首窗口均值），供运行器计算并写入 metrics：
 * 样本不足 2 个或时长 < 2×windowMs（无法构成首末两个窗口）→ null（not-measured，
 * 不折算为通过）。此纯函数承载 Soak 门禁的确定性判定逻辑。
 */
export function soakRatioOrNull(
  points: readonly { readonly tMs: number; readonly value: number }[],
  startMs: number,
  durationMs: number,
  windowMs: number,
): number | null {
  if (durationMs < 2 * windowMs || points.length < 2) return null;
  try {
    return growthRatio(
      points,
      startMs,
      startMs + windowMs,
      startMs + durationMs - windowMs,
      startMs + durationMs,
    );
  } catch {
    return null;
  }
}
