# Integration tests

验证数据库、实时网关及服务端模块之间的集成行为。

入口：`pnpm test:integration`（根 vitest 配置的 `integration` project）。涉及真实数据库的用例使用 [tests/support/test-db.ts](../../../tests/support/test-db.ts)：每次运行唯一 `runId` + 独立 schema，缺配置时整组受控跳过；不依赖真实密钥或第三方网络（docs/06-testing-strategy.md §2.1）。用例落地前本层以 `passWithNoTests` 受控跳过。
