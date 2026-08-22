import { defineConfig } from "vitest/config";

/**
 * Root Vitest project configuration (TEX-12).
 *
 * Layers follow docs/06-testing-strategy.md section 2:
 * - unit        pure-function tests co-located with sources
 *              (apps sources, apps tests/unit dirs, packages sources, tests/support, tests/meta)
 * - rules       poker rule and property tests (packages/poker-engine/tests)
 * - integration server integration tests (apps/game-server/tests/integration)
 * - ws          multiplayer and WebSocket tests (apps/game-server/tests/ws, tests/clients)
 *
 * Include patterns are mutually exclusive so no test file runs in two layers.
 * E2E (tests/e2e, Playwright) and Simulator (tests/simulator, standalone CLI)
 * are invoked via `pnpm test:e2e` and `pnpm test:sim` instead of this config.
 *
 * rules, integration and ws may pass with no test files (passWithNoTests) until
 * the corresponding business code lands - a controlled skip that states clearly
 * that no tests ran, never a fabricated pass.
 */
export default defineConfig({
  test: {
    // 允许空层成功退出（rules/integration/ws 在业务代码落地前的受控跳过）；
    // include 模式的正确性由 tests/meta/test-entrypoints.test.ts 断言保护。
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "apps/*/src/**/*.test.ts",
            "apps/*/tests/unit/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
            "tests/support/**/*.test.ts",
            "tests/meta/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "rules",
          include: ["packages/poker-engine/tests/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["apps/game-server/tests/integration/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "ws",
          include: ["apps/game-server/tests/ws/**/*.test.ts", "tests/clients/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
        },
      },
    ],
  },
});
