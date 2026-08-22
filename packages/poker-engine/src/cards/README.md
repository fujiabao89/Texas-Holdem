# Cards

牌值模型、牌堆、洗牌策略和牌力评估。规则权威见 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md) §7（牌堆/发牌）、§10（Hand Evaluator）、§15（RNG 与可复现性）；本目录 README 只链接引用，不重复规则正文。

## 公开接口

- `card.ts` —— `Suit` / `Rank`（2–14，Ace=14）、`Card`、`createCard`、`isCard`、`cardCode` / `parseCard`、`cardsEqual`、`cardKey`。
- `random-source.ts` —— `RandomSource`（`nextInt(maxExclusive)`）；`SecureRandomSource`（生产，`node:crypto`）；`SeededRandomSource`（测试，固定 seed 复现，弃样消除取模偏差）。
- `deck.ts` —— `Deck`（构造即标准 52 张；`shuffle(rng)` 用 Fisher–Yates；`draw()` 从顶部按序抽牌，耗尽抛 `EmptyDeckError`）、`createStandardDeck`。
- `hand-evaluator.ts` —— `HandRank`、`HandEvaluation`、`evaluateHand(cards)`、`compareEvaluations`、`decideOutcome`、`handRankName` 及输入错误类型。

## 随机性约定

扑克引擎的所有随机性都通过 `RandomSource` 注入；禁止在引擎内直接使用 `Math.random` 或系统时间。测试通过 `SeededRandomSource` 保证同 seed 100% 复现（权威 §15）。

## 测试

本子域的单元测试与源码同包（`src/**/*.test.ts`），由根 [vitest.config.ts](../../../vitest.config.ts) 的 unit 层收集，`pnpm test:unit` 运行；Seed 工具见 [tests/support](../../../../tests/support/README.md)。
