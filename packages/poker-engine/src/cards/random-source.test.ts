import { describe, expect, it } from "vitest";
import { SeededRandomSource, SecureRandomSource } from "./random-source";

describe("SeededRandomSource", () => {
  it("同一 seed 产生完全相同序列（可复现）", () => {
    const a = new SeededRandomSource(42);
    const b = new SeededRandomSource(42);
    for (let i = 0; i < 200; i++) {
      expect(a.nextInt(7)).toBe(b.nextInt(7));
    }
  });

  it("不同 seed 产生的序列不同", () => {
    const a = new SeededRandomSource(42);
    const b = new SeededRandomSource(43);
    const seqA = Array.from({ length: 20 }, () => a.nextInt(7));
    const seqB = Array.from({ length: 20 }, () => b.nextInt(7));
    expect(seqA).not.toEqual(seqB);
  });

  it("nextInt 返回 [0, maxExclusive) 内整数", () => {
    const rng = new SeededRandomSource(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
  });

  it("拒绝非法 maxExclusive 与 seed", () => {
    const rng = new SeededRandomSource(1);
    expect(() => rng.nextInt(0)).toThrow();
    expect(() => rng.nextInt(-1)).toThrow();
    expect(() => rng.nextInt(1.5)).toThrow();
    expect(() => new SeededRandomSource(-1)).toThrow();
    expect(() => new SeededRandomSource(1.5)).toThrow();
  });

  it("拒绝超过 2^32 的区间（防止死循环）", () => {
    const rng = new SeededRandomSource(1);
    expect(() => rng.nextInt(0x1_0000_0001)).toThrow();
  });

  it("支持 maxExclusive = 2^32 边界", () => {
    const rng = new SeededRandomSource(1);
    const v = rng.nextInt(0x1_0000_0000);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0x1_0000_0000);
  });

  it("对不整除 2^32 的区间无取模偏差（粗粒度均匀）", () => {
    const rng = new SeededRandomSource(7);
    const counts = [0, 0, 0, 0];
    const n = 4000;
    for (let i = 0; i < n; i++) {
      counts[rng.nextInt(4)]++;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan((n / 4) * 0.8);
      expect(c).toBeLessThan((n / 4) * 1.2);
    }
  });
});

describe("SecureRandomSource", () => {
  it("nextInt 返回 [0, maxExclusive) 内整数", () => {
    const rng = new SecureRandomSource();
    for (let i = 0; i < 100; i++) {
      const v = rng.nextInt(52);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(52);
    }
  });
});
