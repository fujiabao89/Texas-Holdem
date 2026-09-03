import { describe, expect, it } from "vitest";
import {
  createTestRngFactory,
  TEST_SEED_MODULUS,
} from "./test-rng-factory";

describe("createTestRngFactory（TEX-28 A3：seed 上界与派生边界）", () => {
  it("缺省返回安全随机源工厂（不抛错）", () => {
    expect(() => createTestRngFactory(undefined)).not.toThrow();
  });

  it("拒绝 ≥ 2^32 的 seed（4294967296）", () => {
    expect(() => createTestRngFactory("4294967296")).toThrow(/\[0, 4294967295\]/);
  });

  it("拒绝非整数/负 seed", () => {
    expect(() => createTestRngFactory("-1")).toThrow();
    expect(() => createTestRngFactory("1.5")).toThrow();
  });

  it("边界 seed（4294967295）及其派生递增不越界", () => {
    const factory = createTestRngFactory(String(TEST_SEED_MODULUS - 1));
    // 首场 seed = 4294967295（合法上界）；派生 (seed + ordinal) % 2^32 永在引擎可接受范围。
    expect(() => factory()).not.toThrow();
    expect(() => factory()).not.toThrow();
  });
});
