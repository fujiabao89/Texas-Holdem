/**
 * 随机源抽象（TEX-13）。
 *
 * 所有洗牌 / 随机决策必须通过本接口注入：
 * - 生产：{@link SecureRandomSource}，基于 `node:crypto`，密码学安全，无取模偏差；
 * - 测试：{@link SeededRandomSource}，固定 seed，同一 seed 恒得同一序列，弃样消除偏差。
 *
 * 权威规格：docs/01-engine-spec.md §15（生产密码学安全；测试按 Seed 100% 复现）。
 */
import { randomInt } from "node:crypto";

/** 随机整数上界语义：返回 [0, maxExclusive) 内均匀随机整数，maxExclusive 必须为正整数。 */
export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

/** 生产随机源：`node:crypto.randomInt`，拒绝采样保证无取模偏差。 */
export class SecureRandomSource implements RandomSource {
  nextInt(maxExclusive: number): number {
    return randomInt(maxExclusive);
  }
}

const UINT32_MAX = 0x1_0000_0000; // 2^32

/**
 * 测试随机源：mulberry32 PRNG + 弃样。
 *
 * 同一 `seed` 产生完全相同的序列；弃样保证 [0, maxExclusive) 内均匀分布，无取模偏差。
 */
export class SeededRandomSource implements RandomSource {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error(`SeededRandomSource: seed 必须是非负安全整数，收到 ${seed}`);
    }
    this.seed = seed;
    this.state = seed >>> 0;
  }

  /** 返回 [0, 2^32) 的 32 位无符号整数。 */
  private nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt: maxExclusive 必须为正整数，收到 ${maxExclusive}`);
    }
    const limit = UINT32_MAX - (UINT32_MAX % maxExclusive);
    let value = this.nextUint32();
    while (value >= limit) {
      value = this.nextUint32();
    }
    return value % maxExclusive;
  }
}
