import { defineConfig, devices } from "@playwright/test";

import {
  createRealRunId,
  resolveRealDatabaseUrl,
  schemaNameForRunId,
  withApplicationName,
  writeRunIdentity,
} from "./real/support/run-identity";

/**
 * 真实链路 E2E 配置（TEX-28，docs/06-testing-strategy.md §3.4/§5）。
 *
 * 入口：`pnpm test:e2e:real`（根目录）。
 * 与 tests/e2e/playwright.config.ts（UI 投影 mock 套件）互补，本套件要求：
 * - 真实浏览器 → 真实 apps/web → 真实本地 game-server → 真实 PostgreSQL
 *   （唯一隔离 schema `tex_e2e_real_<runId>`，teardown DROP CASCADE）；
 * - 禁止 route.fulfill / 伪造 Snapshot（docs/06 §5）；
 * - 固定 TEX_TEST_RNG_SEED 确定性洗牌（生产默认安全随机，见 main.ts）；
 * - 重试为 0（docs/06 §2.1）；workers=1 保证跨 Tournament 的 seed 派生顺序确定。
 *
 * 浏览器矩阵：chromium 跑全部用例；firefox / webkit 仅跑 `@key` 标注的关键
 * 流程回归（docs/06 §5.9）。端口默认 3201/3202，勿与 mock 套件（3100）混用。
 */

const serverPort = Number(process.env.TEX_E2E_REAL_SERVER_PORT ?? 3201);
const webPort = Number(process.env.TEX_E2E_REAL_WEB_PORT ?? 3202);
const seed = process.env.TEX_E2E_REAL_SEED ?? "280820";
const runId = createRealRunId();
const schemaName = schemaNameForRunId(runId);
const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const databaseUrl = withApplicationName(
  resolveRealDatabaseUrl(process.env),
  `tex_e2e_real_${runId}`,
);

// 主进程写入运行身份；测试 worker 与 global teardown 读取（跨进程共享）。
writeRunIdentity({ runId, schemaName, serverPort, webPort });

export default defineConfig({
  testDir: "./real",
  outputDir: ".artifacts-real",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: webBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@key/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@key/ },
  ],
  webServer: [
    {
      // 启动器：先构建 game-server 引用的 workspace 包（poker-engine/protocol 的
      // dist 入口），再重建隔离 schema → 版本化迁移 → 生产入口启动真实 game-server；
      // 清洁检出无 dist 时缺构建会 MODULE_NOT_FOUND（与 mock 配置一致的做法）。
      command:
        "pnpm --filter @texas-holdem/poker-engine build && pnpm --filter @texas-holdem/protocol build && pnpm --filter @texas-holdem/game-server exec tsx ../../tests/e2e/real/support/launch-game-server.ts",
      url: `${serverBaseUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DATABASE_URL: databaseUrl,
        DATABASE_SCHEMA: schemaName,
        PORT: String(serverPort),
        HOST: "127.0.0.1",
        TOKEN_HMAC_SECRET: "tex28-e2e-real-token-secret-0000000000000001",
        CORS_ALLOWED_ORIGINS: webBaseUrl,
        TEX_TEST_RNG_SEED: seed,
      },
    },
    {
      // `@texas-holdem/protocol` 从 dist/ 发布入口；清洁检出需先构建（与 mock 套件一致）。
      command: `pnpm --filter @texas-holdem/protocol build && pnpm --filter @texas-holdem/web dev --port ${webPort}`,
      url: webBaseUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_API_BASE_URL: serverBaseUrl,
      },
    },
  ],
  globalTeardown: "./real/global-teardown",
});