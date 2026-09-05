import { describe, expect, it } from "vitest";

import { applySoakMemory, soakCanPass } from "./driver";
import { MetricsCollector } from "./metrics";
import { evaluateSlo } from "./gates";
import type { SloCheck } from "./gates";

const WINDOW_MS = 3_600_000; // 1h

const memoryCheck: SloCheck = {
  id: "memory-growth",
  description: "末小时内存均值 ≤ 稳态小时 1.1 倍",
  threshold: 1.1,
  minSamples: 0,
  measure: { kind: "memory-ratio" },
};

function growingPoints(): { tMs: number; value: number }[] {
  const duration = 4 * WINDOW_MS;
  return [
    { tMs: 60_000, value: 100 },
    { tMs: 1_800_000, value: 110 },
    { tMs: duration - 0.8 * WINDOW_MS, value: 240 },
    { tMs: duration - 0.1 * WINDOW_MS, value: 250 },
  ];
}

describe("driver-soak（采样→写入 collector→门禁 确定性集成）", () => {
  it("比值 >1.1：applySoakMemory 写入 collector 且 memory-growth 门禁失败", () => {
    const metrics = new MetricsCollector();
    const ratio = applySoakMemory(metrics, growingPoints(), 0, 4 * WINDOW_MS, WINDOW_MS);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(1.1);
    expect(metrics.snapshot().memoryGrowthRatio).toBe(ratio);
    const result = evaluateSlo([memoryCheck], metrics.snapshot())[0]!;
    expect(result.verdict).toBe("fail");
  });

  it("时长不足 2h → 不改写 collector，soakCanPass=false（正式 Soak 判 insufficient）", () => {
    const metrics = new MetricsCollector();
    const ratio = applySoakMemory(metrics, growingPoints(), 0, WINDOW_MS, WINDOW_MS);
    expect(ratio).toBeNull();
    expect(metrics.snapshot().memoryGrowthRatio).toBeNull();
    expect(soakCanPass(metrics)).toBe(false);
  });

  it("RSS 样本缺失 → soakCanPass=false（正式 Soak 不判通过）", () => {
    const metrics = new MetricsCollector();
    const ratio = applySoakMemory(metrics, [{ tMs: 0, value: 100 }], 0, 4 * WINDOW_MS, WINDOW_MS);
    expect(ratio).toBeNull();
    expect(soakCanPass(metrics)).toBe(false);
    expect(metrics.snapshot().memoryGrowthRatio).toBeNull();
  });
});
