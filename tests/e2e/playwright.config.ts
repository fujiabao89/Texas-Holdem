import { defineConfig } from "@playwright/test";

/**
 * E2E 测试配置（TEX-12）。
 *
 * 入口：`pnpm test:e2e`（根目录）。
 * 失败产物保留策略（docs/06-testing-strategy.md §9）：
 * - trace / video：`retain-on-failure`（仅失败保留）；
 * - screenshot：`only-on-failure`；
 * - 浏览器 console / pageerror / 网络 / WS 摘要：由 `fixtures/observability.ts`
 *   在测试失败时输出（仅 method+path+status，不带 headers/body/query，防泄露）；
 * - 全部产物写入 `tests/e2e/.artifacts/`（已被 .gitignore 忽略），成功运行自动清理。
 */

const port = Number(process.env.TEX_E2E_PORT ?? 3100);
const baseURL = process.env.TEX_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  outputDir: ".artifacts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter @texas-holdem/web dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
