/**
 * 门禁评估（TEX-29）。
 *
 * 纯函数：把场景的 SLO 阈值表（scenarios.ts）应用到 driver 收集的 PerfMetrics，
 * 输出逐项裁决。裁决类别区分“通过 / 未达标 / 样本不足 / 未测量”——样本不足与
 * 未测量**不等于达标**（docs/06 §10.1 不允许把“没测到”当“通过”）。
 *
 * 量化口径：百分位用 stats.percentile（nearest-rank）；rate 用
 * numerator/denominator；zero 类计数器 >0 即 fail。
 */
import { percentile, ratioOrNull } from "./stats";
import type { PerfMetrics } from "./metrics";

export type GateVerdict = "pass" | "fail" | "insufficient-sample" | "not-measured";

export type SloMeasure =
  | { readonly kind: "latency"; readonly series: "action" | "reconnect"; readonly q: 0.5 | 0.95 | 0.99 }
  | {
      readonly kind: "rate";
      readonly numerator: "http5xx" | "unexpectedDisconnect" | "recoveryFailures";
      readonly denominator: "httpRequests" | "wsConnections" | "recoveryAttempts";
    }
  | { readonly kind: "zero"; readonly counter: "invariantViolations" | "sequenceViolations" | "processCrash" }
  | { readonly kind: "memory-ratio" };

export interface SloCheck {
  readonly id: string;
  readonly description: string;
  /** 判定阈值：latency=ms；rate=百分比小数；memory-ratio=末段/首段比值上限；zero 恒 0。 */
  readonly threshold: number;
  /** 判定所需最少样本（rate 判分母、latency 判样本数）；不足 → insufficient-sample。 */
  readonly minSamples: number;
  readonly measure: SloMeasure;
}

export interface GateResult {
  readonly id: string;
  readonly description: string;
  readonly verdict: GateVerdict;
  /** 实际测量值（未测量/不可判时为 null）。 */
  readonly measured: number | null;
  readonly sampleCount: number;
  readonly threshold: number;
  readonly reason: string;
}

function latencySamples(series: "action" | "reconnect", metrics: PerfMetrics): readonly number[] {
  return series === "action" ? metrics.actionLatencyMs : metrics.reconnectLatencyMs;
}

export function evaluateSlo(
  checks: readonly SloCheck[],
  metrics: PerfMetrics,
): readonly GateResult[] {
  return checks.map((check) => {
    const measure = check.measure;
    switch (measure.kind) {
      case "latency": {
        const samples = latencySamples(measure.series, metrics);
        const sampleCount = samples.length;
        if (sampleCount < check.minSamples) {
          return {
            id: check.id,
            description: check.description,
            verdict: "insufficient-sample",
            measured: null,
            sampleCount,
            threshold: check.threshold,
            reason: `样本 ${sampleCount} < 门槛 ${check.minSamples}`,
          };
        }
        const measured = percentile(samples, measure.q);
        return {
          id: check.id,
          description: check.description,
          verdict: measured <= check.threshold ? "pass" : "fail",
          measured,
          sampleCount,
          threshold: check.threshold,
          reason: measured <= check.threshold ? "达标" : `超出阈值 ${measured} > ${check.threshold}`,
        };
      }
      case "rate": {
        const denominator = metrics[measure.denominator];
        const numerator = metrics[measure.numerator];
        if (denominator < check.minSamples) {
          return {
            id: check.id,
            description: check.description,
            verdict: "insufficient-sample",
            measured: null,
            sampleCount: denominator,
            threshold: check.threshold,
            reason: `分母 ${denominator} < 门槛 ${check.minSamples}`,
          };
        }
        const measured = ratioOrNull(numerator, denominator);
        if (measured === null) {
          return {
            id: check.id,
            description: check.description,
            verdict: "not-measured",
            measured: null,
            sampleCount: denominator,
            threshold: check.threshold,
            reason: "分母为 0",
          };
        }
        return {
          id: check.id,
          description: check.description,
          verdict: measured <= check.threshold ? "pass" : "fail",
          measured,
          sampleCount: denominator,
          threshold: check.threshold,
          reason: measured <= check.threshold ? "达标" : `超出阈值 ${measured} > ${check.threshold}`,
        };
      }
      case "zero": {
        const measured = metrics[measure.counter] === true ? 1 : (metrics[measure.counter] as number);
        return {
          id: check.id,
          description: check.description,
          verdict: measured === 0 ? "pass" : "fail",
          measured,
          sampleCount: 0,
          threshold: 0,
          reason: measured === 0 ? "为 0" : `非 0：${measured}`,
        };
      }
      case "memory-ratio": {
        const measured = metrics.memoryGrowthRatio;
        if (measured === null) {
          return {
            id: check.id,
            description: check.description,
            verdict: "not-measured",
            measured: null,
            sampleCount: 0,
            threshold: check.threshold,
            reason: "driver 未产生 memoryGrowthRatio（时长不足/未采集内存）",
          };
        }
        return {
          id: check.id,
          description: check.description,
          verdict: measured <= check.threshold ? "pass" : "fail",
          measured,
          sampleCount: 0,
          threshold: check.threshold,
          reason: measured <= check.threshold ? "达标" : `内存增长比 ${measured} > ${check.threshold}`,
        };
      }
    }
  });
}

/**
 * 整体门禁结论：任一 fail → "fail"；否则任一 insufficient/not-measured → "not-passed"；
 * 全部 pass → "pass"。不把“样本不足”折算成通过。
 */
export type OverallVerdict = "pass" | "fail" | "not-passed";

export function overallVerdict(results: readonly GateResult[]): OverallVerdict {
  if (results.some((result) => result.verdict === "fail")) return "fail";
  if (results.length > 0 && results.every((result) => result.verdict === "pass")) return "pass";
  return "not-passed";
}
