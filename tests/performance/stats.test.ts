import { describe, expect, it } from "vitest";

import {
  StatsError,
  describeLatencies,
  growthRatio,
  mean,
  percentile,
  ratioOrNull,
  soakRatioOrNull,
  warmupCutoffMs,
  windowMean,
} from "./stats";

describe("stats.percentile（nearest-rank）", () => {
  it("有序输入：p50/p95/p99 落在期望秩", () => {
    // nearest-rank：index = ceil(q*n)-1（1 基）→ 0 基 ceil-1
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5); // ceil(5)-1=4 → values[4]=5
    expect(percentile(values, 0.95)).toBe(10); // ceil(9.5)-1=9 → values[9]=10
    expect(percentile(values, 0.99)).toBe(10);
    expect(percentile(values, 0.25)).toBe(3); // ceil(2.5)-1=2 → values[2]=3
  });

  it("无序输入自动排序", () => {
    expect(percentile([10, 1, 5, 2, 8, 3, 9, 4, 7, 6], 0.5)).toBe(5);
  });

  it("单样本：任意 q 均返回该样本", () => {
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it("空样本抛错（不允许把没测到当达标）", () => {
    expect(() => percentile([], 0.95)).toThrow(StatsError);
  });

  it("非法 q 抛错", () => {
    expect(() => percentile([1, 2, 3], 0)).toThrow(StatsError);
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(StatsError);
  });
});

describe("stats.describeLatencies", () => {
  it("返回 count/mean/min/max/p50/p95/p99", () => {
    const summary = describeLatencies([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(summary.count).toBe(10);
    expect(summary.meanMs).toBe(55);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(100);
    expect(summary.p50).toBe(50);
    expect(summary.p95).toBe(100);
    expect(summary.p99).toBe(100);
  });

  it("空样本抛错", () => {
    expect(() => describeLatencies([])).toThrow(StatsError);
  });
});

describe("stats.mean / windowMean", () => {
  it("mean：空抛错，非空返回均值", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(() => mean([])).toThrow(StatsError);
  });

  it("windowMean 只统计半开窗口 [start,end)", () => {
    const points = [
      { tMs: 0, value: 100 },
      { tMs: 1_000, value: 200 },
      { tMs: 2_000, value: 300 },
      { tMs: 3_000, value: 400 },
    ];
    expect(windowMean(points, 0, 2_000)).toBe(150); // 0 与 1000
    expect(windowMean(points, 2_000, 4_000)).toBe(350); // 2000 与 3000
    expect(() => windowMean(points, 5_000, 6_000)).toThrow(StatsError);
  });
});

describe("stats.growthRatio（Soak 内存门禁）", () => {
  const points = [
    { tMs: 0, value: 100 },
    { tMs: 1_000, value: 100 },
    { tMs: 2_000, value: 200 },
    { tMs: 3_000, value: 200 },
  ];
  it("末段/首段均值比：200/100 = 2", () => {
    expect(growthRatio(points, 0, 2_000, 2_000, 4_000)).toBe(2);
  });
  it("baseline 为 0 抛错（0 均值不能做比）", () => {
    const zeros = [
      { tMs: 0, value: 0 },
      { tMs: 1_000, value: 0 },
      { tMs: 2_000, value: 5 },
    ];
    expect(() => growthRatio(zeros, 0, 2_000, 2_000, 3_000)).toThrow(StatsError);
  });
});

describe("stats.soakRatioOrNull（Soak 运行级判定逻辑）", () => {
  const windowMs = 3_600_000;
  it("时长 ≥2h 且末窗口明显高于首窗口 → 返回 >1.1 的比值（对应 Soak 失败）", () => {
    const start = 0;
    const duration = 4 * windowMs;
    const points = [
      { tMs: 60_000, value: 100 },
      { tMs: 1_800_000, value: 110 },
      { tMs: 3.2 * windowMs, value: 240 },
      { tMs: 3.9 * windowMs, value: 250 },
    ];
    const ratio = soakRatioOrNull(points, start, duration, windowMs);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(1.1);
  });

  it("时长不足 2h（无法构成首末窗口）→ null（正式 Soak 不得通过）", () => {
    const points = [
      { tMs: 0, value: 100 },
      { tMs: 30_000, value: 110 },
    ];
    expect(soakRatioOrNull(points, 0, windowMs, windowMs)).toBeNull();
  });

  it("样本不足 2 个 → null", () => {
    expect(soakRatioOrNull([{ tMs: 0, value: 100 }], 0, 4 * windowMs, windowMs)).toBeNull();
    expect(soakRatioOrNull([], 0, 4 * windowMs, windowMs)).toBeNull();
  });
});

describe("stats.ratioOrNull / warmupCutoffMs", () => {
  it("ratio：分母 0 返回 null（无法判定，区别于 0）", () => {
    expect(ratioOrNull(0, 100)).toBe(0);
    expect(ratioOrNull(1, 0)).toBeNull();
  });

  it("warmupCutoffMs 按比例切分", () => {
    expect(warmupCutoffMs(10_000, 110_000, 0.1)).toBe(20_000);
    expect(warmupCutoffMs(10_000, 110_000, 0.0)).toBe(10_000);
  });
});
