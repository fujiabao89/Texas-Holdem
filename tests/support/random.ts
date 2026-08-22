/**
 * 可复现随机工具（TEX-12）。
 *
 * `createSeededRandom` 提供确定性 PRNG（mulberry32）：同一 seed 的输出序列恒一致，
 * 用于 fixture 数据生成与后续 Simulator 的多局派生。
 *
 * 注意：引擎内部的 `SeededRandomSource`（docs/01-engine-spec.md §15）由 TEX-13 实现；
 * 本模块只服务测试基础设施自身，不定义引擎接口。
 */

export interface SeededRandom {
  readonly seed: number;
  /** 返回 [0, 1) 的确定性伪随机数。 */
  next(): number;
  /** 返回 [min, max] 的确定性整数。 */
  nextInt(min: number, max: number): number;
}

function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRandom(seed: number): SeededRandom {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error(`createSeededRandom: seed 必须是非负安全整数，收到 ${seed}`);
  }
  const next = mulberry32(seed);
  return {
    seed,
    next,
    nextInt(min: number, max: number): number {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
        throw new Error(`nextInt: 非法区间 [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}

/**
 * 从主 seed 与场景标签派生子 seed（FNV-1a）。
 * 同一 (baseSeed, label) 恒得到同一子 seed；不同 label 得到不同子 seed，
 * 供 Simulator 按局/按场景派生独立随机流。
 */
export function deriveSeed(baseSeed: number, label: string): number {
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0) {
    throw new Error(`deriveSeed: baseSeed 必须是非负安全整数，收到 ${baseSeed}`);
  }
  const input = `${baseSeed}:${label}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2147483647;
}
