/**
 * 加权随机场景生成（TEX-16）。
 *
 * 按 docs/06-testing-strategy.md §5 对 2/3/10 人、深浅筹码、多人 All-in、Side Pot、
 * Fold 到底、Heads-Up、盲注上升/下降与三种 Blind Mode 做加权覆盖（非均匀随机）。
 * 全部随机性来自注入的 `SeededRandom`（由 tournament seed 派生），同一 seed 恒生成同一场景。
 *
 * 权威规格：docs/06-testing-strategy.md §5；docs/01-engine-spec.md §12（配置校验）、§15（RNG）。
 */
import { validateTournamentConfig } from "../../../packages/poker-engine/src/index";
import type { BlindLevel, BlindMode } from "../../../packages/poker-engine/src/index";
import type { SeededRandom } from "../../support/random";

/** 代理风格：加权动作分布见 agent.ts；folding 保证「Fold 到底」覆盖。 */
export type AgentStyle = "aggressive" | "balanced" | "cautious" | "folding";
export const AGENT_STYLES: readonly AgentStyle[] = ["aggressive", "balanced", "cautious", "folding"];

/** 筹码深度（相对 BB）。 */
export type StackDepth = "shallow" | "medium" | "deep";
export const STACK_DEPTHS: readonly StackDepth[] = ["shallow", "medium", "deep"];

export interface SimulatorScenario {
  /** 人类可读标签，如 `10p-deep-hands-mix-aggressive`。 */
  readonly label: string;
  readonly playerCount: number;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly blindMode: BlindMode;
  readonly blindStructure: readonly BlindLevel[];
  readonly stackDepth: StackDepth;
  readonly agentStyle: AgentStyle;
  /** `time` 模式下每手之间上报的秒数（确定性，驱动盲注等级推进）。 */
  readonly elapsedSecondsPerHand: number;
}

function pickWeighted<T>(rng: SeededRandom, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let cursor = rng.next() * total;
  for (const [value, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** 玩家数加权：2/3/10 显式加权（规格点名的覆盖维度），4–9 低权重补充。 */
const PLAYER_COUNT_WEIGHTS: readonly (readonly [number, number])[] = [
  [2, 3],
  [3, 3],
  [4, 1],
  [5, 1],
  [6, 1],
  [7, 1],
  [8, 1],
  [9, 1],
  [10, 3],
];

const STACK_DEPTH_WEIGHTS: readonly (readonly [StackDepth, number])[] = [
  ["shallow", 3],
  ["medium", 2],
  ["deep", 3],
];

const BLIND_MODE_WEIGHTS: readonly (readonly [BlindMode, number])[] = [
  ["fixed", 2],
  ["hands", 3],
  ["time", 2],
];

const AGENT_STYLE_WEIGHTS: readonly (readonly [AgentStyle, number])[] = [
  ["aggressive", 3],
  ["balanced", 2],
  ["cautious", 1],
  ["folding", 1],
];

const BIG_BLINDS: readonly number[] = [10, 20, 50, 100];

/** 各深度对应的 BB 倍数区间（闭区间，整数）。 */
const DEPTH_RANGES: Record<StackDepth, readonly [number, number]> = {
  shallow: [10, 30],
  medium: [40, 100],
  deep: [150, 500],
};

function depthRange(depth: StackDepth, rng: SeededRandom): number {
  const [min, max] = DEPTH_RANGES[depth]!;
  return rng.nextInt(min, max);
}

/** 偶数 BB（SB = BB/2 为整数且严格小于 BB）。 */
function nextBlinds(bigBlind: number, rng: SeededRandom, direction: "up" | "down"): { sb: number; bb: number } {
  const factor = rng.nextInt(15, 30) / 10; // 1.5x–3x
  const raw = direction === "up" ? bigBlind * factor : bigBlind / factor;
  // 取 ≥2 的偶数，保证 SB = BB/2 ≥ 1 且为整数。
  const bb = Math.max(2, 2 * Math.max(1, Math.round(raw / 2)));
  return { sb: bb / 2, bb };
}

/**
 * 生成 `hands`/`time` 模式的盲注等级序列：首级等于初始盲注，后续等级随机上升/下降，
 * 且强制同时包含至少一次上升与一次下降（覆盖盲注变更两个方向）。
 */
function buildBlindStructure(
  mode: BlindMode,
  sb: number,
  bb: number,
  rng: SeededRandom,
): { levels: BlindLevel[]; elapsedSecondsPerHand: number } {
  const levelCount = rng.nextInt(3, 6);
  const levels: BlindLevel[] = [];
  let curSb = sb;
  let curBb = bb;
  let hasUp = false;
  let hasDown = false;

  for (let i = 0; i < levelCount; i++) {
    const isFirst = i === 0;
    const isLast = i === levelCount - 1;
    let direction: "up" | "down";
    if (isFirst) {
      direction = "up";
    } else if (isLast && (!hasUp || !hasDown)) {
      direction = hasUp ? "down" : "up";
    } else {
      direction = rng.next() < 0.5 ? "up" : "down";
    }
    if (!isFirst) {
      const next = nextBlinds(curBb, rng, direction);
      curSb = next.sb;
      curBb = next.bb;
    }
    hasUp = hasUp || (!isFirst && direction === "up");
    hasDown = hasDown || (!isFirst && direction === "down");
    levels.push(
      mode === "hands"
        ? { smallBlind: curSb, bigBlind: curBb, hands: rng.nextInt(1, 3) }
        : { smallBlind: curSb, bigBlind: curBb, durationSeconds: rng.nextInt(60, 600) },
    );
  }
  const elapsedSecondsPerHand = rng.nextInt(60, 240);
  return { levels, elapsedSecondsPerHand };
}

/**
 * 从 tournament seed 派生的确定性场景。
 * `forcedBlindMode` 指定时跳过加权随机、强制使用该模式（Nightly 逐模式下限用，
 * docs/06 §5）；其余维度仍由 rng 加权随机决定。
 */
export function generateScenario(rng: SeededRandom, forcedBlindMode?: BlindMode): SimulatorScenario {
  const playerCount = pickWeighted(rng, PLAYER_COUNT_WEIGHTS);
  const blindMode = forcedBlindMode ?? pickWeighted(rng, BLIND_MODE_WEIGHTS);
  const agentStyle = pickWeighted(rng, AGENT_STYLE_WEIGHTS);
  // 弃牌偏好 × 深筹码会退化为数千手盲注磨牌（低信号、高耗时）：
  // folding 只配浅筹码，深筹码覆盖由其余风格承担。
  const stackDepth =
    agentStyle === "folding" ? "shallow" : pickWeighted(rng, STACK_DEPTH_WEIGHTS);
  const bigBlind = BIG_BLINDS[rng.nextInt(0, BIG_BLINDS.length - 1)]!;
  const smallBlind = bigBlind / 2;
  const startingStack = depthRange(stackDepth, rng) * bigBlind;

  let blindStructure: readonly BlindLevel[];
  let elapsedSecondsPerHand = 0;
  if (blindMode === "fixed") {
    blindStructure = [{ smallBlind, bigBlind }];
  } else {
    const built = buildBlindStructure(blindMode, smallBlind, bigBlind, rng);
    blindStructure = built.levels;
    elapsedSecondsPerHand = built.elapsedSecondsPerHand;
  }

  // 防御：生成的配置必须通过引擎唯一校验入口（不得生成引擎会拒绝的场景）。
  validateTournamentConfig({
    maxPlayers: playerCount,
    startingStack,
    smallBlind,
    bigBlind,
    blindMode,
    blindStructure,
  });

  return {
    label: `${playerCount}p-${stackDepth}-${blindMode}-${agentStyle}`,
    playerCount,
    startingStack,
    smallBlind,
    bigBlind,
    blindMode,
    blindStructure,
    stackDepth,
    agentStyle,
    elapsedSecondsPerHand,
  };
}
