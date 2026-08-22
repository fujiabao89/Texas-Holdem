# Simulations

长时间、随机化和基于不变量的扑克引擎验证；不依赖真实网络和数据库。

## 入口（TEX-12）

```bash
pnpm test:sim -- --seed 20260821   # 固定 seed
pnpm test:sim                       # 使用默认 seed 或 TEX_TEST_SEED
```

- 入口：[run.ts](./run.ts)（独立 Node CLI，经 tsx 运行）。Seed 解析复用 [tests/support/seed.ts](../support/seed.ts)，多局派生使用 [deriveSeed](../support/random.ts)。
- **当前状态（受控跳过）**：`packages/poker-engine` 尚未实现（TEX-13 起），入口输出 `RESULT: SKIPPED (engine-not-available)` 并以退出码 0 结束——不执行也不伪造任何牌局。
- 长跑主循环、不变量自动断言、Watchdog 与 PR/Nightly/RC 分层规模由 TEX-16 按 docs/06-testing-strategy.md §5 实现；发现失败时必须能用同一 seed 100% 重放。

## 目录（场景规划，随 TEX-16 落地）

- [invariants/](./invariants)：筹码守恒、牌张唯一、底池结算等不变量断言。
- [long-running-games/](./long-running-games)：完整 Tournament 长跑。
- [random-hands/](./random-hands)：随机牌局生成与检查。
