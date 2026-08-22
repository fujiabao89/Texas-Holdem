import { onTestFailed } from "vitest";
import { formatSeedReport } from "./seed";

/**
 * Seed 失败输出钩子（TEX-12）：
 * 在 `it` 回调内调用一次 `reportSeedOnFailure(seed)`，
 * 测试失败时输出 seed 与复现方式；不改变测试结果本身。
 * 与 seed.ts 分离以保持后者零框架依赖（Simulator CLI 可直接复用）。
 */
export function reportSeedOnFailure(seed: number): void {
  onTestFailed(() => {
    console.error(formatSeedReport(seed));
  });
}
