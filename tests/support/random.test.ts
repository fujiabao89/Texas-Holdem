import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSeededRandom, deriveSeed } from "./random";

describe("createSeededRandom", () => {
  it("同一 seed 产生完全一致的序列", () => {
    const a = createSeededRandom(12345);
    const b = createSeededRandom(12345);
    const sequenceA = Array.from({ length: 100 }, () => a.next());
    const sequenceB = Array.from({ length: 100 }, () => b.next());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("不同 seed 产生不同序列", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const sequenceA = Array.from({ length: 20 }, () => a.next());
    const sequenceB = Array.from({ length: 20 }, () => b.next());
    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("next() 恒在 [0, 1)；nextInt() 恒在闭区间内", () => {
    const random = createSeededRandom(42);
    for (let i = 0; i < 1000; i++) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const integer = random.nextInt(3, 7);
      expect(Number.isInteger(integer)).toBe(true);
      expect(integer).toBeGreaterThanOrEqual(3);
      expect(integer).toBeLessThanOrEqual(7);
    }
  });

  it("非法 seed 与非法区间抛出明确错误", () => {
    expect(() => createSeededRandom(-1)).toThrow(/非负安全整数/);
    expect(() => createSeededRandom(1.5)).toThrow(/非负安全整数/);
    expect(() => createSeededRandom(1).nextInt(5, 3)).toThrow(/非法区间/);
  });

  it("性质：任意 seed 下两次独立实例序列一致（fast-check，固定 seed 保证可复现）", () => {
    const arbitrarySeed = fc.integer({ min: 0, max: 2 ** 31 - 1 });
    fc.assert(
      fc.property(arbitrarySeed, fc.integer({ min: 1, max: 50 }), (seed, length) => {
        const first = createSeededRandom(seed);
        const second = createSeededRandom(seed);
        for (let i = 0; i < length; i++) {
          expect(first.next()).toBe(second.next());
        }
      }),
      { seed: 20260821 },
    );
  });
});

describe("deriveSeed", () => {
  it("同一 (baseSeed, label) 派生一致；不同 label 派生不同", () => {
    expect(deriveSeed(100, "hand-1")).toBe(deriveSeed(100, "hand-1"));
    expect(deriveSeed(100, "hand-1")).not.toBe(deriveSeed(100, "hand-2"));
    expect(deriveSeed(100, "hand-1")).not.toBe(deriveSeed(200, "hand-1"));
  });

  it("派生 seed 为非负且可直接用于 createSeededRandom", () => {
    const derived = deriveSeed(20260821, "nightly-run");
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(() => createSeededRandom(derived)).not.toThrow();
    expect(createSeededRandom(derived).next()).toBe(createSeededRandom(derived).next());
  });

  it("非法 baseSeed 抛出明确错误", () => {
    expect(() => deriveSeed(-1, "x")).toThrow(/非负安全整数/);
  });
});
