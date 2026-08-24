# Poker engine source

引擎实现根目录。所有随机性必须通过可注入接口取得，生产环境使用安全随机源。

## 当前已实现（TEX-13 + TEX-14 + TEX-15）

- `cards/` —— 牌、牌堆、随机源与牌型评估（Card / Deck / RandomSource / Hand Evaluator）。
- `model/` —— 领域类型层（纯类型、零依赖，打破 engine↔rules 循环依赖；含 tournament 类型）。
- `rules/` —— 盲注/行动顺序、下注规则与 LegalActions、发公共牌、锦标赛规则（配置校验/盲注等级/Dealer 轮转）。
- `pots/` —— 底池分层与未跟注返还、每池独立比牌与 Odd Chip。
- `events/` —— 手级 + 锦标赛级领域事件（含 sequence；BURN_CARD 无牌面）。
- `timer/` —— 行动时限 / Time Bank 纯领域模型（实际调度在 game-server）。
- `engine/` —— `PokerHandEngine`（纯 reducer + 门面）、`TournamentEngine`（锦标赛编排）与手级/锦标赛不变量断言。

## 尚待落地（TEX-15 之后）

协议 Schema、状态投影（`PlayerView`/`BotView` 私有信息过滤）、Headless Simulator（TEX-16）。规则与接口定义一律链接 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md)，不在子 README 重复。
