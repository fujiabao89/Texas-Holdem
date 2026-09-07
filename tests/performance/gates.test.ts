import { describe, expect, it } from "vitest";

import type { PerfMetrics } from "./metrics";
import { evaluateSlo, overallVerdict } from "./gates";
import type { SloCheck } from "./gates";

function emptyMetrics(overrides: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    actionLatencyMs: [],
    reconnectLatencyMs: [],
    http5xx: 0,
    httpRequests: 0,
    unexpectedDisconnect: 0,
    wsConnections: 0,
    recoveryFailures: 0,
    recoveryAttempts: 0,
    invariantViolations: 0,
    sequenceViolations: 0,
    processCrash: false,
    memoryGrowthRatio: null,
    ...overrides,
  };
}

const actionP95: SloCheck = {
  id: "action-p95",
  description: "Action→Event p95 ≤250 ms",
  threshold: 250,
  minSamples: 100,
  measure: { kind: "latency", series: "action", q: 0.95 },
};

describe("gates.evaluateSlo", () => {
  it("latency：样本达门槛且百分位不超阈值 → pass", () => {
    const results = evaluateSlo([actionP95], emptyMetrics({ actionLatencyMs: Array.from({ length: 200 }, (_, i) => 100 + (i % 50)) }));
    const result = results[0]!;
    expect(result.verdict).toBe("pass");
    expect(result.measured).toBeLessThanOrEqual(250);
  });

  it("latency：超出阈值 → fail 并给出 measured", () => {
    const results = evaluateSlo([actionP95], emptyMetrics({ actionLatencyMs: Array.from({ length: 200 }, () => 900) }));
    expect(results[0]!.verdict).toBe("fail");
    expect(results[0]!.measured).toBe(900);
  });

  it("latency：样本不足 → insufficient-sample（不等于达标）", () => {
    const results = evaluateSlo([actionP95], emptyMetrics({ actionLatencyMs: [1, 2, 3] }));
    expect(results[0]!.verdict).toBe("insufficient-sample");
    expect(results[0]!.reason).toContain("3 < 门槛 100");
  });

  it("rate：numerator/denominator 达标；分母不足 → insufficient-sample", () => {
    const check: SloCheck = {
      id: "business-5xx",
      description: "业务 5xx <0.1%",
      threshold: 0.001,
      minSamples: 100,
      measure: { kind: "rate", numerator: "http5xx", denominator: "httpRequests" },
    };
    expect(evaluateSlo([check], emptyMetrics({ http5xx: 1, httpRequests: 1000 }))[0]!.verdict).toBe("pass");
    expect(evaluateSlo([check], emptyMetrics({ http5xx: 30, httpRequests: 1000 }))[0]!.verdict).toBe("fail");
    expect(evaluateSlo([check], emptyMetrics({ http5xx: 1, httpRequests: 10 }))[0]!.verdict).toBe(
      "insufficient-sample",
    );
  });

  it("zero：计数器 0 → pass；非 0 → fail；processCrash true → fail", () => {
    const check: SloCheck = {
      id: "invariant-zero",
      description: "Invariant violation = 0",
      threshold: 0,
      minSamples: 0,
      measure: { kind: "zero", counter: "invariantViolations" },
    };
    expect(evaluateSlo([check], emptyMetrics())[0]!.verdict).toBe("pass");
    expect(evaluateSlo([check], emptyMetrics({ invariantViolations: 2 }))[0]!.verdict).toBe("fail");
    const crashCheck: SloCheck = {
      id: "no-crash",
      description: "不崩溃",
      threshold: 0,
      minSamples: 0,
      measure: { kind: "zero", counter: "processCrash" },
    };
    expect(evaluateSlo([crashCheck], emptyMetrics({ processCrash: true }))[0]!.verdict).toBe("fail");
  });

  it("memory-ratio：null → not-measured；≤阈值 pass；>阈值 fail", () => {
    const check: SloCheck = {
      id: "memory-growth",
      description: "内存末小时 ≤ 稳态小时 1.1 倍",
      threshold: 1.1,
      minSamples: 0,
      measure: { kind: "memory-ratio" },
    };
    expect(evaluateSlo([check], emptyMetrics())[0]!.verdict).toBe("not-measured");
    expect(evaluateSlo([check], emptyMetrics({ memoryGrowthRatio: 1.05 }))[0]!.verdict).toBe("pass");
    expect(evaluateSlo([check], emptyMetrics({ memoryGrowthRatio: 1.5 }))[0]!.verdict).toBe("fail");
  });

  it("reconnect latency 用 reconnect 系列与自身阈值", () => {
    const check: SloCheck = {
      id: "reconnect-p99",
      description: "认证至快照 p99 ≤2000 ms",
      threshold: 2_000,
      minSamples: 500,
      measure: { kind: "latency", series: "reconnect", q: 0.99 },
    };
    const results = evaluateSlo(
      [check],
      emptyMetrics({ reconnectLatencyMs: Array.from({ length: 600 }, (_, i) => 300 + (i % 700)) }),
    );
    expect(results[0]!.verdict).toBe("pass");
    expect(results[0]!.sampleCount).toBe(600);
  });
});

describe("gates.overallVerdict", () => {
  it("全部 pass → pass；任一 fail → fail；只有样本不足 → not-passed", () => {
    const m = (v: "pass" | "fail" | "insufficient-sample") =>
      ({ id: "x", description: "x", verdict: v, measured: 1, sampleCount: 1, threshold: 1, reason: "" }) as const;
    expect(overallVerdict([m("pass"), m("pass")])).toBe("pass");
    expect(overallVerdict([m("pass"), m("fail")])).toBe("fail");
    expect(overallVerdict([m("pass"), m("insufficient-sample")])).toBe("not-passed");
    expect(overallVerdict([])).toBe("not-passed");
  });
});
