/**
 * Smoke / Nightly / RC 三档种子规划（TEX-16）。
 *
 * 按 docs/06-testing-strategy.md §5【工程基线】：
 * - PR Smoke：已知失败 seed 回归集 + 从提交 SHA 确定性派生 ≥200 个新 seed；
 * - Nightly：≥10,000 场（同一提交 SHA 确定性派生，新提交产生新 seed 集）；
 * - RC：以累计 ≥50,000 场、其中 ≥10,000 个此前未运行 seed 为目标（依赖 seed 台账）。
 *
 * 全部派生为 FNV-1a 纯函数：同一 SHA 恒得同一 seed 集，可复核、可重放。
 */
import type { BlindMode } from "../../packages/poker-engine/src/index";
import { KNOWN_FAILURE_SEEDS } from "./known-seeds";

export type SimulatorTier = "smoke" | "nightly" | "rc";

export interface TierPlan {
  readonly tier: SimulatorTier;
  readonly seeds: number[];
  /**
   * 与 `seeds` 等长的强制 Blind Mode（Nightly 逐模式下限用）：
   * 指定时该 seed 的场景强制使用该模式（docs/06 §5「每个受支持 Blind 模式合计 ≥10,000 场」）；
   * 缺省（undefined 或整个数组缺省）由场景加权随机选择。
   */
  readonly blindModes?: readonly (BlindMode | undefined)[];
  /** 本档种子来源说明（写入运行摘要）。 */
  readonly description: string;
}

export const SMOKE_MIN_SHA_DERIVED_GAMES = 200;
/** Nightly 逐 Blind Mode 下限（docs/06 §5：每个受支持 Blind 模式合计 ≥10,000 场）。 */
export const NIGHTLY_DEFAULT_GAMES = 10_000;
/** 全部受支持的 Blind Mode（Nightly 逐模式下限的划分维度）。 */
export const NIGHTLY_BLIND_MODES: readonly BlindMode[] = ["fixed", "hands", "time"];
export const RC_CUMULATIVE_TARGET = 50_000;
export const RC_MIN_FRESH_SEEDS = 10_000;

/** FNV-1a：同一输入恒得同一 32 位无符号值。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 从提交 SHA 派生 count 个确定性 seed（可加命名空间区分用途）。 */
export function deriveSeedsFromSha(sha: string, count: number, namespace = ""): number[] {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`deriveSeedsFromSha: 非法 SHA ${JSON.stringify(sha)}`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`deriveSeedsFromSha: count 必须为非负整数，收到 ${count}`);
  }
  const seeds: number[] = [];
  const seen = new Set<number>();
  let i = 0;
  while (seeds.length < count) {
    const seed = fnv1a(`${sha.toLowerCase()}:${namespace}:${i}`);
    i++;
    if (seen.has(seed)) continue; // 32 位空间下碰撞概率可忽略，防御死循环
    seen.add(seed);
    seeds.push(seed);
  }
  return seeds;
}

/** Smoke：已知失败 seed 回归集 + ≥200 个 SHA 派生新 seed。 */
export function planSmokeSeeds(sha: string, games?: number): TierPlan {
  const derived = Math.max(SMOKE_MIN_SHA_DERIVED_GAMES, games ?? SMOKE_MIN_SHA_DERIVED_GAMES);
  const seeds = [...KNOWN_FAILURE_SEEDS, ...deriveSeedsFromSha(sha, derived, "smoke")];
  return {
    tier: "smoke",
    seeds,
    description: `已知失败 seed ${KNOWN_FAILURE_SEEDS.length} 个 + SHA 派生 ${derived} 个（≥${SMOKE_MIN_SHA_DERIVED_GAMES}）`,
  };
}

/**
 * Nightly：同一提交 SHA 按**每种 Blind Mode 各**确定性派生 ≥10,000 个强制该模式的 seed
 * （docs/06 §5：每个受支持 Blind 模式合计 ≥10,000 场；合计 ≥3 × 10,000）。
 * `--games` 只可上调逐模式下限，不可降低。
 */
export function planNightlySeeds(sha: string, games?: number): TierPlan {
  const perMode = Math.max(NIGHTLY_DEFAULT_GAMES, games ?? NIGHTLY_DEFAULT_GAMES);
  const seeds: number[] = [];
  const blindModes: BlindMode[] = [];
  for (const mode of NIGHTLY_BLIND_MODES) {
    for (const seed of deriveSeedsFromSha(sha, perMode, `nightly-${mode}`)) {
      seeds.push(seed);
      blindModes.push(mode);
    }
  }
  return {
    tier: "nightly",
    seeds,
    blindModes,
    description:
      `SHA 派生 ${NIGHTLY_BLIND_MODES.length} × ${perMode} 场` +
      `（每种 Blind Mode ≥${NIGHTLY_DEFAULT_GAMES}，docs/06 §5）`,
  };
}

export interface RcPlanOptions {
  /** 本候选提交此前已运行的 seed（计入累计，不需重跑）。 */
  readonly ranForSha: ReadonlySet<number>;
  /** 任意场景此前已运行的 seed（不再计为 fresh）。 */
  readonly ranEver: ReadonlySet<number>;
  /** 累计目标（默认 50,000；测试可调小）。 */
  readonly totalTarget?: number;
  /** fresh 目标（默认 10,000；测试可调小）。 */
  readonly freshTarget?: number;
}

/**
 * RC：在候选提交命名空间内派生 seed，直到「累计 ≥ totalTarget 且本次新增 fresh
 * ≥ freshTarget」。已为该 SHA 运行过的 seed 计入累计但跳过重跑。
 */
export function planRcSeeds(sha: string, options: RcPlanOptions): TierPlan {
  const totalTarget = options.totalTarget ?? RC_CUMULATIVE_TARGET;
  const freshTarget = options.freshTarget ?? RC_MIN_FRESH_SEEDS;
  const needNew = Math.max(0, totalTarget - options.ranForSha.size);
  const runNow = Math.max(needNew, freshTarget);
  const seeds: number[] = [];
  const selected = new Set<number>();
  let fresh = 0;
  let i = 0;
  while (seeds.length < runNow || fresh < freshTarget) {
    const seed = fnv1a(`${sha.toLowerCase()}:rc:${i}`);
    i++;
    if (options.ranForSha.has(seed) || selected.has(seed)) continue;
    selected.add(seed);
    seeds.push(seed);
    if (!options.ranEver.has(seed)) fresh++;
  }
  return {
    tier: "rc",
    seeds,
    description: `本次新增 ${seeds.length} 个（fresh ≥${freshTarget}），此前该 SHA 已运行 ${options.ranForSha.size} 个，累计目标 ≥${totalTarget}`,
  };
}
