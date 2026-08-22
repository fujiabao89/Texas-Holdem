import { criticalViolations } from "./fixtures/a11y";
import { expect, test } from "./fixtures/observability";

/**
 * E2E 冒烟（TEX-12）：只验证 Playwright + axe-core + 失败产物基础设施可运行，
 * 不测试任何扑克业务（产品 E2E 由后续任务在 tests/e2e/<场景>/ 下实现）。
 */

test("Playwright 基础设施可加载页面", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "德州扑克" })).toBeVisible();
});

test("axe-core 扫描可运行且脚手架页面无 critical 违规", async ({ page }) => {
  await page.goto("/");
  const violations = await criticalViolations(page);
  const compact = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
  }));
  expect(compact, JSON.stringify(compact, null, 2)).toEqual([]);
});
