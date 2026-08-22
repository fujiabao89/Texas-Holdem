# Game server tests

服务端应用层与基础设施适配测试；纯扑克规则测试归属 `packages/poker-engine`。

## 分层归属（TEX-12）

| 目录 | 层 | 根入口 |
| --- | --- | --- |
| `unit/` 与 `src/**/*.test.ts` | Unit | `pnpm test:unit` |
| `integration/` | Integration | `pnpm test:integration` |
| `ws/` | Multiplayer/WebSocket | `pnpm test:ws` |
| `fixtures/` | 可复用测试数据与替身（非测试文件，不被自动收集） | — |

测试由根 [vitest.config.ts](../../../vitest.config.ts) 分层收集，本包不再单独维护 vitest 脚本；层间 include 互斥，无重复执行。共享工具（Seed、Fake Clock、Fixture Builder、数据库隔离）见 [tests/support/](../../../tests/support/README.md)。

- Integration 涉及数据库时使用 `tests/support/test-db.ts` 的 `describeTestDatabase`：缺配置受控跳过，有配置时按 `runId` 使用独立 schema。
- WS 层多客户端驱动约定见 docs/06-testing-strategy.md §6；用例落地前该层以 `passWithNoTests` 受控跳过。
