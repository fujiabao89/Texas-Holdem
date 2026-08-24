# Poker engine

纯领域包：德州扑克规则、状态机、牌力计算、底池和可验证的领域事件。不得依赖网络、数据库、UI 或框架。

规则与接口的权威定义见 [docs/01-engine-spec.md](../../docs/01-engine-spec.md)；本包 README 只链接引用权威规格，不重复规则正文。

## 当前实现范围（TEX-14 + TEX-15）

在 TEX-13 的 `src/cards/`（牌、牌堆、随机源、七选五评估）之上实现**单局 No-Limit Hold'em 手牌引擎（TEX-14）与单桌 Freezeout 锦标赛引擎（TEX-15）**：

- `src/model/` —— 领域类型层（纯类型、零依赖，打破 engine↔rules 循环依赖）：`Street`/`HandPhase`/`ActionType`/`ActionSource`、`PlayerAction`、`LegalActions`、`PlayerState`、`Pot`/`PotAward`、`GameState`/`HandConfig`/`HandOutcome`。
- `src/rules/` —— 盲注与行动顺序（`blinds`）、下注规则/最小加注/Short All-in 权重开/`LegalActions`（`betting`/`legal-actions`）、发公共牌（`street`）。
- `src/pots/` —— 底池分层与未跟注返还（`layering`）、每池独立比牌与 Odd Chip（`settlement`）。
- `src/events/` —— 领域事件（含 `sequence`；`BURN_CARD` **不含牌面**）。
- `src/engine/` —— `PokerHandEngine`（纯 reducer + 薄门面，§16 确定性纯转移）、`TournamentEngine`（锦标赛编排）与不变量断言（`invariants`/`tournament-invariants`，§17）。
- `src/rules/tournament.ts` —— 唯一配置校验 `validateTournamentConfig`、盲注等级计算（固定/按时间/按手数）、Dealer 轮转、同手淘汰排序（§12）。
- `src/timer/` —— 行动时限 / Time Bank 纯领域模型（§12、§13；实际调度在 game-server）。

核心行为：单手状态机（盲注、逐张底牌、Preflop/Flop/Turn/River、Burn、Showdown、结算）、Heads-Up 与多人桌的 Button/SB/BB/发牌/行动顺序、`LegalActions` 唯一来源、Fold/Check/Call/Bet/Raise/All-in（`betTo`/`raiseTo` 目标总投入语义）、最小下注/最小完整加注/Short Call All-in/Short All-in 与下注权重开、按 `handContribution` 分层结算主池与任意数量边池、Fold 玩家保留贡献但不可获奖、未跟注顶层返还、每池独立决胜与 Odd Chip（Dealer 左顺时针）、提前结算（仅剩一名/全员 All-in 自动补牌）。金额一律整数。锦标赛：初始筹码、首手/后续 Hand、Blind Level（只在 Hand 间生效、允许下降）、Dealer 轮转（跳过 ELIMINATED/WITHDRAWN）、淘汰与同手多人淘汰稳定排序、唯一冠军、`EXIT_PENDING`/`WITHDRAWN` 与 `forfeitedChips` 筹码守恒、`PLAYER_ELIMINATED`/`PLAYER_WITHDRAWN`/`TOURNAMENT_FINISHED` 事件。

## 分层与准入

- 单元层：`src/**/*.test.ts`（`pnpm test:unit`）——纯函数（下注规则、底池分层/结算、事件）边界。
- 规则层：`tests/**/*.test.ts`（`pnpm test:rules`）——整手行为（弃牌胜出、Heads-Up 比牌、非法动作原子性、全下 Runout）。
- 不变量：每个合法动作与结算后由 `assertInvariants(state)` 自动断言（§17）；详见 [docs/06-testing-strategy.md](../../docs/06-testing-strategy.md) §3.1/§4。

## 尚待落地

协议 Schema（`packages/protocol`）、状态投影（`PlayerView`/`BotView` 私有信息过滤）与 Headless Simulator（TEX-16）属后续任务。私有信息（他人底牌、牌堆顺序、Burn 牌面）只存在于 `getState()`（服务端内部权威状态）与内部事件流，客户端/AI 一律经 game-server 投影取数。
