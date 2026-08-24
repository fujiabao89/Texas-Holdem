# Project-level tests

跨应用的端到端、模拟和性能验证。测试必须覆盖协议、断线恢复和关键扑克不变量（docs/06-testing-strategy.md）。

## 测试入口（TEX-12 起）

| 命令 | 层 | 目录 / 归属 | 运行器 |
| --- | --- | --- | --- |
| `pnpm test:unit` | Unit | `apps/*/src`、`apps/*/tests/unit`、`packages/*/src`、`tests/support`、`tests/meta` | Vitest（根 `vitest.config.ts`） |
| `pnpm test:rules` | Poker Rule | `packages/poker-engine/tests` | Vitest |
| `pnpm test:integration` | Integration | `apps/game-server/tests/integration` | Vitest |
| `pnpm test:ws` | Multiplayer/WS | `apps/game-server/tests/ws`、`tests/clients` | Vitest |
| `pnpm test:e2e` | E2E | `tests/e2e` | Playwright（[tests/e2e/README.md](./e2e/README.md)） |
| `pnpm test:sim -- --seed <n>` / `--tier smoke\|nightly\|rc` | Simulation | `tests/simulator`（模块自测归 unit 层） | 独立 Node CLI（[tests/simulator/README.md](./simulator/README.md)） |
| `pnpm test` | 上述 Vitest 层总入口（unit+rules+integration+ws） | — | Vitest |

各层 include 模式互斥，同一测试文件不会被两层重复执行；层级配置的唯一事实来源是根 [vitest.config.ts](../vitest.config.ts)（`tests/meta/` 的自测会守护入口与互斥性）。规则/集成/WS 层在对应业务代码落地前以 `passWithNoTests` 受控跳过（成功退出且明确输出未发现测试，不伪造结果）。

## 目录

| 目录 | 职责 |
| --- | --- |
| [support/](./support) | 可复用测试工具：Seed、确定性 PRNG、Fake Clock、Fixture Builder、测试数据库隔离（各自带自测） |
| [meta/](./meta) | 测试入口与分层配置的结构性自测 |
| [e2e/](./e2e) | Playwright E2E 与失败产物保留 |
| [simulator/](./simulator) | Headless Simulator：长跑主循环、不变量断言、Watchdog、Smoke/Nightly/RC 三档与失败产物（TEX-16 已落地，见 [tests/simulator/README.md](./simulator/README.md)） |
| [performance/](./performance) | Load/Soak（Artillery，后续任务建设，见 docs/06 §10） |

## 约定

- 测试不依赖真实密钥、生产数据库、第三方网络或任意 sleep；时序用 `tests/support` 的 Fake Clock，随机用可复现 seed。
- 每个 Vitest 测试自建 Fixture/实例，不共享可变状态，可并行执行。
