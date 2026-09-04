/**
 * TEX-28 测试随机源工厂（纯函数，独立于 main 便于回归）。
 *
 * `SeededRandomSource` 只接受 [0, 2^32) 内的整数 seed（packages/poker-engine），
 * 超界会 throw。若校验放行 ≥2^32，派生 seed 又未做边界处理，则 rngFactory 在
 * Tournament 运行时注册（Room 已提交 IN_GAME）处抛错，房间会停留在 IN_GAME 却无
 * 运行时（Codex P2 / Greptile P1 / CodeRabbit Major 一致指出）。本工厂：
 * - 配置 seed 必须为 [0, 2^32) 内整数，否则启动即拒绝（先于任何开局副作用）；
 * - 派生 seed 以 2^32 取模，保证随 tournamentOrdinal 增长永不越界且仍确定性。
 */
import {
  RandomSource,
  SecureRandomSource,
  SeededRandomSource,
} from "@texas-holdem/poker-engine";

export const TEST_SEED_MODULUS = 2 ** 32;

export function createTestRngFactory(rawSeed: string | undefined): () => RandomSource {
  if (rawSeed === undefined) return () => new SecureRandomSource();
  const seed = Number(rawSeed);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= TEST_SEED_MODULUS) {
    throw new Error(
      `TEX_TEST_RNG_SEED 必须为 [0, ${TEST_SEED_MODULUS - 1}] 内整数，收到 "${rawSeed}"`,
    );
  }
  let tournamentOrdinal = 0;
  return () => new SeededRandomSource((seed + tournamentOrdinal++) % TEST_SEED_MODULUS);
}
