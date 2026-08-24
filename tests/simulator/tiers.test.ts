import { describe, expect, it } from "vitest";
import {
  deriveSeedsFromSha,
  planNightlySeeds,
  planRcSeeds,
  planSmokeSeeds,
  SMOKE_MIN_SHA_DERIVED_GAMES,
  NIGHTLY_DEFAULT_GAMES,
} from "./tiers";
import { KNOWN_FAILURE_SEEDS } from "./known-seeds";

const SHA = "fc4ad2ffab13c0d3e5f6a7b8c9d0e1f2a3b4c5d6";

describe("deriveSeedsFromSha", () => {
  it("同一 SHA + 命名空间恒派生同一 seed 集（可复核）", () => {
    expect(deriveSeedsFromSha(SHA, 250, "smoke")).toEqual(deriveSeedsFromSha(SHA, 250, "smoke"));
  });

  it("不同 SHA / 命名空间派生不同 seed 集", () => {
    const a = deriveSeedsFromSha(SHA, 250, "smoke");
    const otherSha = deriveSeedsFromSha("0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4", 250, "smoke");
    const otherNs = deriveSeedsFromSha(SHA, 250, "nightly");
    expect(a).not.toEqual(otherSha);
    expect(a).not.toEqual(otherNs);
  });

  it("seed 值为 [0, 2^32) 且无重复", () => {
    const seeds = deriveSeedsFromSha(SHA, 1_000);
    expect(new Set(seeds).size).toBe(1_000);
    for (const seed of seeds) {
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });

  it("非法 SHA 抛错", () => {
    expect(() => deriveSeedsFromSha("xyz", 10)).toThrow(/非法 SHA/);
    expect(() => deriveSeedsFromSha(SHA, -1)).toThrow();
  });
});

describe("Smoke 档（已知失败 seed + SHA 派生 ≥200）", () => {
  it("包含已知失败 seed 回归集与 ≥200 个 SHA 派生 seed", () => {
    const plan = planSmokeSeeds(SHA);
    expect(plan.tier).toBe("smoke");
    expect(plan.seeds.length).toBeGreaterThanOrEqual(KNOWN_FAILURE_SEEDS.length + SMOKE_MIN_SHA_DERIVED_GAMES);
    // 已知 seed 排在最前（回归集优先执行）。
    expect(plan.seeds.slice(0, KNOWN_FAILURE_SEEDS.length)).toEqual([...KNOWN_FAILURE_SEEDS]);
  });

  it("--games 覆盖只增不减（下限 200 受保护）", () => {
    expect(planSmokeSeeds(SHA, 50).seeds.length).toBeGreaterThanOrEqual(SMOKE_MIN_SHA_DERIVED_GAMES);
    expect(planSmokeSeeds(SHA, 300).seeds.length).toBeGreaterThanOrEqual(300);
  });
});

describe("Nightly 档（≥10,000 场）", () => {
  it("默认派生 ≥10,000 个 seed；更小的 --games 被下限保护", () => {
    const plan = planNightlySeeds(SHA);
    expect(plan.seeds.length).toBeGreaterThanOrEqual(NIGHTLY_DEFAULT_GAMES);
    expect(planNightlySeeds(SHA, 100).seeds.length).toBe(NIGHTLY_DEFAULT_GAMES);
    expect(planNightlySeeds(SHA, 12_345).seeds.length).toBe(12_345);
  });
});

describe("RC 档（累计 ≥50,000 且 fresh ≥10,000）", () => {
  it("空台账：派生 50,000 个全新 seed（全部 fresh）", () => {
    const plan = planRcSeeds(SHA, { ranForSha: new Set(), ranEver: new Set() });
    expect(plan.seeds.length).toBe(50_000);
  });

  it("台账已有 40,000 个该 SHA seed：本次仍需 ≥10,000 个 fresh", () => {
    const existing = new Set(deriveSeedsFromSha(SHA, 40_000, "rc"));
    // 模拟此前运行恰好是同一派生流的前 40,000 个：重跑会得到相同候选。
    const plan = planRcSeeds(SHA, { ranForSha: existing, ranEver: existing });
    expect(plan.seeds.length).toBeGreaterThanOrEqual(10_000);
    // 选出的 seed 全部不在该 SHA 已运行集合中（不浪费重跑）。
    for (const seed of plan.seeds) {
      expect(existing.has(seed)).toBe(false);
    }
  });

  it("全局已运行种子不计为 fresh：延长派生直到满足 fresh 配额", () => {
    // 预先占用 RC 派生流的前 8 个候选（视为在 nightly 等场景已运行）。
    const preRun = new Set(deriveSeedsFromSha(SHA, 8, "rc"));
    const plan = planRcSeeds(SHA, {
      ranForSha: new Set(),
      ranEver: preRun,
      totalTarget: 10,
      freshTarget: 5,
    });
    // 前 8 个候选是 stale：fresh 配额 5 迫使派生延伸到 13 个。
    expect(plan.seeds.length).toBe(13);
    const fresh = plan.seeds.filter((s) => !preRun.has(s));
    expect(fresh.length).toBe(5);
    // 该 SHA 已运行 30/50,000 时：needNew = 9,995？——此处用小目标验证取 max 语义。
    const plan2 = planRcSeeds(SHA, {
      ranForSha: new Set(deriveSeedsFromSha(SHA, 4, "rc")),
      ranEver: new Set(),
      totalTarget: 10,
      freshTarget: 3,
    });
    expect(plan2.seeds.length).toBe(6); // max(10-4, 3)
  });
});
