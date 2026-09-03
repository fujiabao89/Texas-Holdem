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
  // real/ 为真实链路套件（需 PostgreSQL 隔离 schema），由 playwright.real.config.ts 独立运行，
  // 不得混入本 UI 投影 mock 套件（无真实 game-server/DB webServer）。
  testIgnore: /real\//,
  outputDir: ".artifacts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // 禁用重试（含 CI）：docs/06 §2.1 规定重试只可用于诊断，
  // 不得把"重试后通过"记为门禁通过；Flaky 用例等同失败。
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // `@texas-holdem/protocol` publishes its workspace entry point from dist/.
    // CI installs from a clean checkout, so build this direct Web dependency before
    // starting Next; local runs are equally deterministic when dist/ is absent.
    command: `pnpm --filter @texas-holdem/protocol build && pnpm --filter @texas-holdem/web dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
