# Poker engine tests

规则、状态机、牌力与底池的单元和性质测试。

## 分层归属（TEX-12）

| 目录 | 层 | 根入口 |
| --- | --- | --- |
| `tests/`（本目录） | Poker Rule（规则/性质/回归测试） | `pnpm test:rules` |
| `src/**/*.test.ts`（与源码同包） | Unit（纯函数，如 Hand Evaluator、金额计算） | `pnpm test:unit` |

由根 [vitest.config.ts](../../../vitest.config.ts) 分层收集，两层 include 互斥。包（TEX-13 起）落地前 `pnpm test:rules` 以 `passWithNoTests` 受控跳过——成功退出且明确输出未发现测试，不伪造结果。

随机性约定：规则测试使用可复现 seed（[tests/support](../../support/README.md)），禁止非注入式随机源与系统时间（docs/06-testing-strategy.md §2.1）；确定性回归 Fixture 按 docs/06 §3.4 组织。

TEX-13 的 Card / Deck / 随机源 / Hand Evaluator 属于纯领域逻辑，其单元测试与源码同包，位于 `src/**/*.test.ts`（unit 层，`pnpm test:unit`）。本 `tests/` 目录（rules 层）等待下注、底池、状态机等规则/性质测试（TEX-14 / TEX-15）落地后再填充。
