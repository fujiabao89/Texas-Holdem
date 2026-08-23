# Poker engine source

引擎实现根目录。所有随机性必须通过可注入接口取得，生产环境使用安全随机源。

## 当前已实现（TEX-13 + TEX-14）

- `cards/` —— 牌、牌堆、随机源与牌型评估（Card / Deck / RandomSource / Hand Evaluator）。
- `model/` —— 领域类型层（纯类型、零依赖，打破 engine↔rules 循环依赖）。
- `rules/` —— 盲注/行动顺序、下注规则与 LegalActions、发公共牌。
- `pots/` —— 底池分层与未跟注返还、每池独立比牌与 Odd Chip。
- `events/` —— 手级领域事件（含 sequence；BURN_CARD 无牌面）。
- `engine/` —— `PokerHandEngine`（纯 reducer + 门面）与不变量断言。

## 尚待落地（TEX-15 等）

`timer/`（行动时限/时间银行，实际调度在 game-server）、Tournament（淘汰/排名/冠军/闭注升级/退出撤回与 `forfeitedChips`）、协议 Schema 与状态投影。规则与接口定义一律链接 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md)，不在子 README 重复。
