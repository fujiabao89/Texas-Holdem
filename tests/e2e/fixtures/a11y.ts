import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * axe-core 可访问性扫描 helper（TEX-12）。
 *
 * 只提供可复用的扫描入口；具体的可访问性验收门槛（WCAG 2.2 AA、键盘主流程等）
 * 按 docs/05-frontend-spec.md §16 由后续前端任务在对应页面补齐断言。
 */

export type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/** 返回 impact 达到及超过指定级别的违规（默认仅 critical）。 */
export async function scanAxeViolations(
  page: Page,
  options?: { minImpact?: "critical" | "serious" | "moderate" | "minor" },
): Promise<AxeViolation[]> {
  const minImpact = options?.minImpact ?? "critical";
  const order = ["critical", "serious", "moderate", "minor"] as const;
  const threshold = order.indexOf(minImpact);
  // 等文档进入稳定可观测态（加载完成且 SSR <title> 就绪）再扫描，避免 WebKit 等
  // 冷启动下页面 shell 已渲染而 <head> 元数据尚未应用造成的 document-title 竞态误报。
  // 若页面真实缺失 <title>，此处等待超时被吞掉，axe 仍会如实报告 document-title 违规。
  await page
    .waitForFunction(() => document.readyState === "complete" && document.title.trim().length > 0, {
      timeout: 15_000,
    })
    .catch(() => undefined);
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((violation) => {
    if (violation.impact === null || violation.impact === undefined) {
      return false;
    }
    const rank = order.indexOf(violation.impact);
    return rank >= 0 && rank <= threshold;
  });
}

/** 返回 critical 级违规（当前脚手架页面的冒烟门槛）。 */
export async function criticalViolations(page: Page): Promise<AxeViolation[]> {
  return scanAxeViolations(page, { minImpact: "critical" });
}
