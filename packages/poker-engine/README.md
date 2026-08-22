# Poker engine

纯领域包：德州扑克规则、状态机、牌力计算、底池和可验证的领域事件。不得依赖网络、数据库、UI 或框架。

规则与接口的权威定义见 [docs/01-engine-spec.md](../../docs/01-engine-spec.md)；本包 README 只链接引用权威规格，不重复规则正文。

## 当前实现范围（TEX-13）

实现 `src/cards/` 子域：

- `card.ts` —— Card 基础模型（四种花色、2–A 牌面值、无 Joker）。
- `random-source.ts` —— 随机源抽象：生产用 `SecureRandomSource`（`node:crypto`），测试用 `SeededRandomSource`（固定 seed，100% 复现，弃样消除取模偏差）。
- `deck.ts` —— 标准 52 张 Deck（Fisher–Yates 洗牌、按序抽牌、耗尽即失败），以及 `createStandardDeck`。
- `hand-evaluator.ts` —— 七选五 Hand Evaluator（九种牌型、可排序比较键、`bestFiveCards`），独立于 UI/网络/协议/下注。

测试：`src/**/*.test.ts`（单元层，`pnpm test:unit`）。分层与准入见 [docs/06-testing-strategy.md](../../docs/06-testing-strategy.md) §2/§3。

## 尚待落地

下注、底池/边池、Hand 状态机、Tournament、Game Events 等属于 TEX-14 / TEX-15；目录结构已在 `src/` 下以 README 预留。扑克随机性规则与 `SeededRandomSource` 语义见权威规格 §15；不可在包外实现第二份 RNG。
