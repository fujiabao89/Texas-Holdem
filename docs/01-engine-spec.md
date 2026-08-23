# 01 · Poker Engine 规格（`packages/poker-engine`）

> 状态：草稿
> 规划核对：2026-08-21（Engineering Documentation Agent）——编写时项目尚无代码，全文为设计意图；2026-08-22 经 TEX-13 实现 `cards/` 子域（§7 牌堆、§10 Hand Evaluator、§15 RNG、§17 相关不变量），其余章节仍为设计意图。
> 权威范围：本文是 Poker Engine 纯规则行为的唯一权威来源——牌堆与发牌、下注与最小加注、Pot/Side Pot/Split、Hand 状态机、Hand Evaluator、Tournament 淘汰与排名、Game Events、RNG 与 Engine Invariants。范围之外的事实（Room、WebSocket 协议、持久化、AI、UI）见 [工程文档总索引](./README.md)。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§2/§3/§4/§6/§9）；《德州扑克项目规划_区块6-10_v0.2.docx》§6/§9（仅在《总规划》未覆盖处补充）；《德州扑克项目规划_区块1-5_v0.1.docx》§2（牌型顺序等基础规则）
> 对应代码：`packages/poker-engine/src/`。TEX-13 已实现 `cards/`（Card、标准 52 张 Deck、随机源、七选五 Hand Evaluator）；其余子域（下注、Pot、状态机、Tournament、Game Events、Timer）随 TEX-14 / TEX-15 落地。目录实际布局与现状见 §3。
> 上级索引：[工程文档总索引](./README.md)

> **【设计意图 · 部分实现】** 本文主要来自已确认规划文档；规划未覆盖但实现必需的工程裁决记录在 §20/§21。`cards/` 子域（§7 牌堆、§10 Hand Evaluator、§15 RNG、§17 相关不变量）已由 TEX-13 落地并与实现核对；其余章节（下注、Pot、状态机、Tournament、Game Events、Timer）仍为设计意图，待 TEX-14/15 实现后逐条回填。当前无开放 TBD。

## 1. Purpose

规则正确性是本产品的核心价值：P0 级缺陷（错误发牌、重复牌、Pot/赢家错误、比赛死锁）直接禁止上线（《总规划》§9.2）。Poker Engine 因此必须满足：

- 在**无 UI、无 WebSocket、无 DeepSeek、无数据库**的条件下独立运行完整的标准 No-Limit Texas Hold'em Tournament（《区块6-10 v0.2》§6.1）。
- 是项目的四个核心技术资产之一（《区块6-10 v0.2》§10.20），也是实施路线图第 1 步：先于 UI、联机与 AI 完成规则并跑通 Headless Simulation（《总规划》§10.1–10.13）。

## 2. Responsibilities / Non-Responsibilities

### 2.1 负责

| 职责 | 依据 |
| --- | --- |
| 牌堆、洗牌、发牌、Burn Card | 《区块6-10 v0.2》§6.1 |
| Dealer、SB/BB、行动顺序 | 同上 |
| Fold/Check/Call/Bet/Raise/All-in 的校验与执行 | 同上 |
| Main Pot / 任意数量 Side Pot / Split Pot | 同上 |
| Street 推进、Showdown、牌型比较 | 同上 |
| 淘汰、排名、比赛结束 | 同上 |
| 直接输出当前玩家的 `LegalActions`，不允许 UI/AI 自行推断 | 《区块6-10 v0.2》§6.7 |
| 产出结构化 Game Events（动画/历史/调试/恢复/Replay 的输入） | 《区块6-10 v0.2》§6.12 |
| 维护 Engine Invariants 并使其在每次合法 Action 后可断言 | 《区块6-10 v0.2》§6.15/§9.8 |
| `TournamentConfig` 规则约束的定义与校验（SB/BB 正整数且 `SB < BB`、初始筹码与层级数为受限正整数、每个 Blind Level 独立校验、允许盲注下降） | 《总规划》§2.3 |

### 2.2 不负责（及归属）

| 不负责 | 归属 | 依据 |
| --- | --- | --- |
| 页面动画与音效 | `apps/web`（AnimationQueue） | 《总规划》§7.2 |
| WebSocket、邀请码、身份与 Token | `apps/game-server` | 《总规划》§5.2 |
| DeepSeek API 调用与 AI 推理 | `server/ai`（P1） | 《总规划》§8 |
| 房间身份与数据库连接 | `apps/game-server` | 《区块6-10 v0.2》§7.19 |
| 客户端 UI 状态 | `apps/web` | 《区块6-10 v0.2》§6.1 |
| 网络幂等与并发裁决：`actionId` 去重、`expectedSequence` 校验、`receivedAt` 记录、单桌串行队列 | `apps/game-server` 串行执行器 | 《总规划》§3.2 |
| 定时任务：Action Timer、Time Bank、断线计时 | `apps/game-server` Scheduler | 《总规划》§6；《区块6-10 v0.2》§7.14 |
| 状态投影（`PlayerView`/`BotView` 私有信息过滤） | `apps/game-server` State Projector | 《总规划》§5.3 |
| 连接状态（`ConnectionStatus`）的维护 | `apps/game-server` | 《区块6-10 v0.2》§6.3 |

超时产生的 Auto Check/Auto Fold 与 AI 产生的动作都**以 Action 形式走同一 Engine 校验路径**（`ActionSource = HUMAN_SOCKET | BOT_CONTROLLER | SYSTEM_TIMER`，《总规划》§6），Engine 不区分来源。

## 3. Dependencies

| 依赖 | 类型 | 用途 | 失效影响 |
| --- | --- | --- | --- |
| `RandomSource` | 接口注入 | 洗牌、首手 Dealer 随机 | 生产用密码学安全源；测试注入 `SeededRandomSource`（§6.13） |
| `apps/game-server` Tournament Manager | 运行时调用方 | 驱动 Hand/Tournament 状态机 | 唯一真实状态在 Server；Engine 只提供规则计算（《总规划》§6） |

- 无其他运行时依赖：该 package **不得依赖 UI、网络、数据库、AI**（《总规划》§6）。P0 不启用 BOT，但 `participant.kind = HUMAN | BOT` 从第一天建模（《总规划》§6）。
- Engine 不依赖 `poker-math`；Equity/Pot Odds 等确定性计算服务于 P1 的 AI Context，不是 Engine 的规则输入（《总规划》§8）。

包内目录（《区块6-10 v0.2》§10.6 为规划目录；以仓库实际布局为准，见下）。实际布局（`packages/poker-engine/src/`，随各自任务落地并更新本文）：

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `cards/` | 牌与牌面表示、牌堆与洗牌、随机源接口、牌型评估 | TEX-13 已落地（统一落于此，暂未拆分） |
| `engine/` | 牌局状态、回合推进、状态转换和规则协调 | TEX-14 已落地 |
| `rules/` | 盲注、合法动作、下注、全下和摊牌等可单独验证的规则 | TEX-14 已落地 |
| `pots/` | 主池、边池、分池和结算分配规则 | TEX-14 已落地 |
| `events/` | 不可变的扑克领域事件（手级：HAND_STARTED … POT_AWARDED） | TEX-14 已落地（手级）；`PLAYER_ELIMINATED` / `TOURNAMENT_FINISHED` 留 TEX-15 |
| `timer/` | 行动时限与时间银行的领域模型 | 占位 · TEX-15（实际调度在 game-server） |

> **工程裁决（TEX-13，2026-08-22）**：Card、标准 52 张 Deck、随机源与 Hand Evaluator 统一落在 `cards/`，**暂不拆分**规划中的 `deck/`、`evaluator/`、`rng/` 三个子目录；后续任务若需拆分，以本文更新为准。《区块6-10 v0.2》§10.6 的 `deck/ hand/ betting/ pot/ evaluator/ tournament/ state/ actions/ rng/` 为规划目录，不再代表仓库实际结构。

## 4. 数据模型

> 本节只规定 Engine 的**内存**状态域。持久化（PostgreSQL 表模型）见 [03-data-model.md](./03-data-model.md)；wire 可见的投影类型见 [02-protocol-spec.md](./02-protocol-spec.md) §9。

### 4.1 状态域（《区块6-10 v0.2》§6.3）

| 域 | 内容 |
| --- | --- |
| Tournament | 比赛 ID、Blind Level、排名、比赛状态 |
| Table | Seat、Dealer、SB、BB |
| Players | `chips`、`holeCards`、`streetBet`、`handContribution` |
| Hand | `handNumber`、`street`、`communityCards`、`deck` |
| Betting | `currentActor`、`currentBet`、`lastFullRaiseSize`、`legalActions` |
| Pots | Main Pot、Side Pots、`eligiblePlayers` |

### 4.2 Seat

- 2–10 个稳定 Seat；空位、真人、AI、淘汰者都具有固定 `seatIndex`（《总规划》§2.1）。Seat 是一等概念，Dealer 与行动顺序基于 Seat 顺时针计算（《区块6-10 v0.2》§6.3）。

### 4.3 Player

- 扑克状态与连接状态分离：`PokerStatus=ACTIVE` 与 `ConnectionStatus=DISCONNECTED` 可同时存在（《区块6-10 v0.2》§6.3）。Engine 不维护 `ConnectionStatus`，但玩家模型必须与连接解耦：断线不改变任何扑克状态【设计意图】。
- `chips == 0` **不能**直接视为 `ELIMINATED`：玩家可能正在 All-in，须等当前 Hand 完整结算（《区块6-10 v0.2》§6.3；《总规划》§2.2）。
- 筹码为整数：所有筹码金额均为非负整数；SB、BB、初始筹码与每个 Blind Level 必须为正整数，且 `SB < BB`（§5.1、§12）。
- `streetBet`：本街道已投入金额；`handContribution`：本手总投入（Side Pot 分层依据，见 §9）。

## 5. Interfaces

### 5.1 Action 输入

| 项 | 规定 | 依据 |
| --- | --- | --- |
| 动作类型 | `Fold` / `Check` / `Call` / `Bet` / `Raise` / `All-in` | 《区块6-10 v0.2》§6.2 |
| 金额语义 | 优先 `raiseTo` / `betTo`（目标总额），避免 `raiseBy` 歧义 | 同上 |
| 来源 | `ActionSource = HUMAN_SOCKET \| BOT_CONTROLLER \| SYSTEM_TIMER`；P0 只启用 `HUMAN_SOCKET` 与 `SYSTEM_TIMER`，不启用 `BOT_CONTROLLER` | 《总规划》§6 |
| 调用方保证 | 同一 `actionId` 最多执行一次；`expectedSequence` 过期即拒绝并下发最新 Snapshot；`receivedAt` 记录与串行队列 | 《总规划》§3.2（Engine 边界之外） |

Engine 对**送达后**的每个 Action 再次校验（《总规划》附录 B 红线 4；《区块6-10 v0.2》§8.8）：

- actor 是当前 `currentActor`；
- 动作类型在当前局面合法；
- 金额合法：所有筹码金额均为非负整数；`Bet`/`Raise` 的 `*To` 是本街道目标总投入，须满足对应的最小值和 `maxRaiseTo`；`Call` 不带自选金额，投入 `min(callAmount, chips)`；`All-in` 必须投入该玩家全部剩余筹码；
- 校验失败 → 拒绝该 Action，**不产生任何状态变更**。

### 5.2 `LegalActions` 输出（《区块6-10 v0.2》§6.7）

```text
LegalActions {
  canFold
  canCheck
  canCall
  callAmount
  canBet
  minBetTo
  canRaise
  minRaiseTo
  maxRaiseTo
  canAllIn
  allInTo
}
```

- Engine 直接提供当前玩家的合法动作集合；UI 与 AI 不得自行推断。
- `callAmount = max(0, currentBet - actor.streetBet)`；只有 `callAmount > 0 && chips >= callAmount` 时 `canCall` 为真。筹码不足时只能以 `All-in` 完成 Short Call。
- `canBet` 只在 `currentBet = 0` 时为真；`minBetTo = BB`。`canRaise` 只在可做**完整** Raise 时为真：若本轮尚无完整 Bet 或 Raise（即首笔下注是低于 BB 的 Short All-in），`minRaiseTo = BB`；否则 `minRaiseTo = currentBet + lastFullRaiseSize`。不适用的最小值字段为 `null`。
- `maxRaiseTo` 与 `allInTo` 都表示当前玩家本街道的目标总投入，恒为 `streetBet + chips`；前者只是完整 Raise 的上限，不表示 Short All-in 也可作为普通 Raise 提交。
- `canAllIn` 在 `chips > 0` 且全下会改变本街投入时为真。Engine 内部维护 `currentBet`、`lastFullRaiseSize` 与每位玩家的下注权状态，并正确处理 Re-Raise、Short All-in、Short Call All-in 与下注权是否重新开放。

### 5.3 Game Events 输出

见 §14。

## 6. Hand 状态机

完整流程（《总规划》§2.2；《区块6-10 v0.2》§6.5）：

```text
HAND_START → POST_BLINDS → DEAL_HOLE_CARDS → PREFLOP
→ BURN/FLOP → BURN/TURN → BURN/RIVER
→ SHOWDOWN → POT_SETTLEMENT → HAND_END
```

| 迁移 | 触发/前置 | 副作用 |
| --- | --- | --- |
| `HAND_START → POST_BLINDS` | 上一手 `HAND_END` 结算完成（或比赛开始） | 收取 SB/BB；Heads-Up 下 Button 缴 SB |
| `POST_BLINDS → DEAL_HOLE_CARDS` | 盲注记账完成 | 每人发 2 张底牌（顺序见 §7） |
| `DEAL_HOLE_CARDS → PREFLOP` | 发牌完成 | 行动权交给首个行动者（见 §11） |
| `PREFLOP → BURN/FLOP` | Betting Round 结束（§8.5） | 烧 1 张，发 3 张公共牌 |
| `BURN/FLOP → BURN/TURN` | 同上 | 烧 1 张，发 1 张 |
| `BURN/TURN → BURN/RIVER` | 同上 | 烧 1 张，发 1 张 |
| `BURN/RIVER → SHOWDOWN` | 同上 | 停止下注，进入比牌 |
| `SHOWDOWN → POT_SETTLEMENT` | 比牌完成，各 Pot 赢家确定 | 分配筹码、记 `forfeitedChips` 相关状态 |
| `POT_SETTLEMENT → HAND_END` | 结算完成 | 执行淘汰/排名判定（§12） |

关键规则：

- **提前结算 1**：仅剩一名未 Fold 玩家 → 直接进入 `POT_SETTLEMENT`（《区块6-10 v0.2》§6.5）。
- **提前结算 2**：所有剩余玩家均已 All-in → Engine 立即完成剩余公共牌与结果计算，**不等待**客户端；前端仍按动画队列逐步展示（《区块6-10 v0.2》§6.5）。
- 盲注变更只在当前 Hand 完整结束后生效，绝不在一手牌中途改变下注下限或盲注（《总规划》§2.3）。
- 淘汰判定在 `HAND_END` 的筹码结算之后进行（《总规划》§2.2）。
- **实现说明（TEX-14）**：`SHOWDOWN → POT_SETTLEMENT` 在引擎中为 `settle()` 内的**原子**转移——一次状态转移内完成揭示与分池结算并落到 `hand_end`，不暴露独立的可观测 `showdown` 相态；因此 `GameState.phase` 只取街名或 `hand_end`（见 §4）。

非法迁移（例如跳过 Burn 阶段直接 `PREFLOP → RIVER`、或从 `SHOWDOWN` 回退）必须拒绝，并视为 Critical Engine Error 处理（见 §16）。

## 7. 发牌、牌堆与 Burn Card

- 标准 52 张、无 Joker（《总规划》§2.2）。
- 标准发牌顺序：Hole Cards ×2 → Burn ×1 → Flop ×3 → Burn ×1 → Turn ×1 → Burn ×1 → River ×1（《区块6-10 v0.2》§6.6/§9.3）。
- 每轮底牌均从 Dealer 左侧第一名仍在本 Hand 的玩家起顺时针各发一张；完成一轮后以同一顺序发第二张。Heads-Up 时 Button/SB 先获第一张底牌。
- Burn Card 牌面属于隐藏信息：**任何客户端与 AI 永远不可获得**（《区块6-10 v0.2》§6.6）；Burn 事件只携带"发生了 Burn"，不携带牌面（《总规划》§7.2 规定前端只展示牌背移出、永不翻开）。
- 同一 Hand 内任意 Card 最多出现一次（不变量，§17）。
- Deck 顺序只存在于服务器内部，不进入客户端或 AI（《区块6-10 v0.2》§6.13；《总规划》§5.3）。

## 8. 下注规则

### 8.1 基本动作（《区块1-5 v0.1》§2.2）

| 动作 | 定义 |
| --- | --- |
| Fold | 弃牌；本手已投入筹码保留在 Pot，失去获奖资格 |
| Check | 当前无需跟注时过牌 |
| Call | 补足至当前最高下注（`currentBet`） |
| Bet | 当前无人下注时下注 |
| Raise | 提高当前最高下注（受最小加注约束，§8.2） |
| All-in | 投入全部剩余筹码（可低于最小加注，§8.3；可低于 Call 额，§8.4） |

### 8.2 最小下注、最小加注与完整加注（《区块1-5 v0.1》§2.3；《区块6-10 v0.2》§6.7）

- 无人下注时，普通 `Bet` 的最小目标额是当前 BB；`Bet` 至少为 BB 才是完整开注。普通 Raise 的最小幅度**不低于上一笔完整 Bet 或 Raise 的幅度**；Engine 维护 `lastFullRaiseSize`。
- 每个 Betting Round 均按**当前 BB** 初始化最小下注/完整加注基准，因此下降盲注不继承上一手的基准。Pre-Flop 初始 `currentBet = BB`、`lastFullRaiseSize = BB`；Flop、Turn、River 初始 `currentBet = 0`、`lastFullRaiseSize = BB`【设计意图 · 未实现】。
- 首个 All-in 若低于 BB，虽合法但不是完整开注；其后的非 All-in 下注至少须到 BB。该玩家之外尚未行动者仍有完整下注/加注权。
- Re-Raise、最小加注与 Raise 权重开是**最容易出现隐蔽 Bug 的区域**，必须作为 P0 规则测试覆盖多个序列（《区块6-10 v0.2》§6.8）。

### 8.3 Short All-in（《区块1-5 v0.1》§2.3；《区块6-10 v0.2》§6.8）

- 筹码不足以完成完整 Raise 的 All-in 是**合法**的。
- 例：A Bet 500 → B Raise to 1000（完整加注幅度 500）→ C 仅剩 1300 可 All-in（只增加 300，属 Short All-in）。A/B 再次面对该动作时**通常只能 Call 或 Fold 额外的 300**，不因这次不足额加注重新获得 Raise 权。
- 面对 Short All-in 时，尚未在该轮行动的玩家保有完整 Raise 权。已行动玩家只有在其上一次主动决定后，`currentBet` 的**累计**增长达到当时的 `lastFullRaiseSize`，才重新获得 Raise 权；多个 Short All-in 的增长应累计计算。否则只可 Fold、Check（如适用）、Call 或 All-in。Engine 必须在状态中记录每名玩家上次行动时面对的下注额及对应完整加注幅度。

### 8.4 Short Call All-in（《区块6-10 v0.2》§9.4）

- 玩家剩余筹码少于 `callAmount` 时，可合法 All-in 投入全部剩余筹码。

### 8.5 Betting Round 结束条件（《区块6-10 v0.2》§6.9）

**不能**用"每个人行动过一次"判断。同时满足之一即结束：

1. 所有仍可行动的玩家都已响应当前最高下注，且不存在新的完整 Raise 要求其再次行动；
2. 仅剩一名未 Fold 玩家；
3. 所有剩余玩家均已 All-in。

### 8.6 金额合法性

所有金额由 Engine 再次校验（《总规划》附录 B 红线 4）；非法金额拒绝且状态不变。快捷下注的筹码舍入属于 UI 层（《区块6-10 v0.2》§9.16），Engine 只接受最终合法整数金额。

## 9. Pot / Side Pot / Split Pot / Odd Chip

- 结算模型：按每名玩家本手总贡献（`handContribution`）**分层结算**，而不是在每次下注时实时拆分 Side Pot【设计意图 · 规划建议】；每个 Pot 同时记录 `contributors` 与 `eligiblePlayers`（《区块6-10 v0.2》§6.10）。
- Fold 玩家已投入筹码保留在 Pot，但失去获奖资格（不进入 `eligiblePlayers`）（《总规划》§2.2；《区块6-10 v0.2》§6.10）。
- 支持普通 Pot、单 Side Pot、任意数量 Side Pot、Split Pot（平分）（《区块6-10 v0.2》§6.10）。
- 在构造 Pot 前，从最高贡献层向下重复检查：若某一层只有一名贡献者，则该层为未被跟注的下注，必须从其 `handContribution` 中剥离并退回该玩家；直到所有剩余贡献层至少有两名贡献者。不得创建只有一名 `contributor` 的 Pot。退回后才按贡献层形成 Main Pot 与 Side Pot，且 Fold 玩家仍作为 `contributors` 计入金额、永不进入 `eligiblePlayers`。
- Odd Chip：每个被 Split 的 Pot 独立处理余数；从 Dealer 左侧开始顺时针，给**第一个符合该 Pot 获奖资格的赢家**（《总规划》§2.2）。
- Showdown 按各 Pot 独立比较与展示（《区块1-5 v0.1》§5.11）。

## 10. Hand Evaluator（《区块6-10 v0.2》§6.11；《区块1-5 v0.1》§2.6）

- 独立于 Tournament 与 UI：输入 Hole Cards + Community Cards → 输出 `HandRank`、**比较键**与 `bestFiveCards`。
- `bestFiveCards` 供 Showdown 动画高亮最终组成牌型的五张牌（《区块6-10 v0.2》§6.11；《区块1-5 v0.1》§5.11）。
- 牌型顺序（低 → 高）：High Card < One Pair < Two Pair < Three of a Kind < Straight < Flush < Full House < Four of a Kind < Straight Flush（Royal Flush 视为最高 Straight Flush，不单列）。
- 必须正确处理：同牌型 Kicker 比较；A-2-3-4-5 为 5-high Straight；Board Plays（最佳五张完全来自公共牌）。
- 比较键必须可排序，供 Showdown 逐 Pot 决出赢家。

## 11. Dealer、盲注与行动顺序

| 规则 | 内容 | 依据 |
| --- | --- | --- |
| 首手 Dealer | 从 `PokerStatus = ACTIVE`、筹码大于 0 且未撤回的 Seat 中用**服务器随机源**选择 | 《总规划》§2.1 |
| 后续 Dealer | 每手结束顺时针移动到下一名仍在比赛中的 Seat；跳过空位、退出者与淘汰者 | 《总规划》§2.1 |
| 盲注 | ≥3 人：Dealer 左侧依次为 SB、BB；Heads-Up：Dealer 同时是 SB | 《区块6-10 v0.2》§6.4 |
| Pre-Flop 首个行动者 | 多人桌：BB 左侧第一名玩家；Heads-Up：Button/SB 先行动 | 《区块1-5 v0.1》§2.4；§6.4 |
| Post-Flop 首个行动者 | Dealer 左侧第一名仍在牌局中的玩家；Heads-Up：BB 先行动 | 《区块1-5 v0.1》§2.4；§6.4 |
| 行动流转 | 顺时针；跳过已 Fold、已 All-in、无合法行动的玩家 | 《区块6-10 v0.2》§6.3（推论） |

## 12. Tournament 层（《区块6-10 v0.2》§6.14）

- **分工**：`PokerHandEngine` 负责一手牌（§6–§11）；`TournamentEngine` 负责初始筹码、Blind Level、玩家淘汰、排名、下一手、Heads-Up 切换与最终 Champion（§6.14）。
- **配置**：单人模式与好友房共用同一套 `TournamentConfig`：`maxPlayers`、`startingStack`、`smallBlind`、`bigBlind`、`blindMode`、`blindStructure`、`actionTime`、`timeBank`（§10.11；《总规划》§6）。筹码、盲注、下注、Pot 与 `forfeitedChips` 均使用非负整数筹码单位；`startingStack`、SB、BB 和各 Blind Level 为受限正整数，且 `SB < BB`。Engine 导出唯一的 `validateTournamentConfig(config)` 规则校验；game-server 的 Schema Validation 只负责外部请求的形状、类型与调用该校验，不得另行放宽或改写规则。
- `actionTime` 只允许 `15/20/30/45/60` 秒或 `UNLIMITED`，默认 30 秒；`timeBank` 总额只允许 `0/30/60/120` 秒，默认 60 秒。`UNLIMITED` 时 `timeBank` 必须为 0。Time Bank 单次最多消耗/延长 30 秒且每个行动机会最多成功一次；执行仍属于 game-server Scheduler，不进入 Engine 玩家 Action 联合类型。
- **Blind Level**：固定 / 按时间 / 按手数三种模式（《总规划》§2.3）；只在两手之间更新（§6.14）；**允许盲注下降**，每个 Level 独立校验（《总规划》§2.3）；按手数升盲示例：每 5 Hands，第 6 Hand 使用新级别（§9.6）。
- **淘汰**：当前 Hand 完整结算后 `chips` 仍为 0 → `ELIMINATED`（《总规划》§2.2）。Freezeout，无 Rebuy（§2.2）。
- **同手多人淘汰**：以该手**开始时**的筹码较多者排名更高；开始筹码相同则 `seatIndex` 升序作为稳定展示顺序。结果模型使用 `EliminationGroup { handNumber, placementRange: { from, to }, players[] }`：同手淘汰者共享同一 `placementRange`，`players[]` 按上述稳定规则排序；个人记录使用 `placementRange` 与 `displayOrder`，不得把展示顺序写成扑克规则上的先后淘汰（《总规划》§2.1）。
- **冠军**：仅在 `HAND_END` 的淘汰与撤回都处理完毕后，剩一名 `PokerStatus = ACTIVE` 的参与者时产生冠军（《总规划》§2.2）。`ELIMINATED` 与 `WITHDRAWN` 均不计为仍在赛；连接状态不影响其资格。P0 仅将符合开局条件的真人纳入比赛，P1 可加入仍在参赛的 AI。
- **淘汰者**：不再获得发牌、行动或缴盲（§6.15）。

## 13. 退出/撤回与筹码守恒（`WITHDRAWN` / `forfeitedChips`）

判定与计时属 game-server（§2.2），本文只规定 Engine 侧的状态转移（《总规划》§4.1）：

1. 玩家被标记 `EXIT_PENDING`（主动离开确认，或断线满 10 分钟）后：当前 Hand 如能正常结算则先结算；**未 All-in 且仍有行动资格者立即按弃权折叠处理**，已投入筹码仍留在相应 Pot。
2. 在安全结算点转为 `WITHDRAWN`：不再获得后续发牌、盲注、行动或排名资格；未投入的剩余筹码记入 `forfeitedChips`，不会无端赠与其他玩家。
3. 筹码守恒不变量因此扩展为：**在场筹码 + 未结算 Pot + `forfeitedChips` = 初始总筹码**（《总规划》§4.1）。

冲突记录：此式取代《区块6-10 v0.2》§6.15 的旧式"玩家筹码 + 未结算 Pot = 比赛总筹码"（见 §21 冲突 2）。`WITHDRAWN` 以独立的 Tournament 级 `WithdrawParticipant` 指令进入 Engine：game-server 在同一 Tournament 串行队列中提交该指令，Engine 校验 `EXIT_PENDING` 与安全结算点；它不是玩家下注 Action，也不占用 `currentActor`。

## 14. Game Events（《区块6-10 v0.2》§6.12）

| 事件 | 用途 |
| --- | --- |
| `HAND_STARTED` / `BLIND_POSTED` / `DEAL_HOLE_CARD` | 手号、Dealer、盲注及逐张发牌流程；事件载荷使用目标总投入与实际投入额 |
| `BURN_CARD` / `FLOP_DEALT` / `TURN_DEALT` / `RIVER_DEALT` | 公共牌动画与历史；`BURN_CARD` **不携带牌面** |
| `PLAYER_CHECKED` / `PLAYER_CALLED` / `PLAYER_BET` / `PLAYER_RAISED` / `PLAYER_FOLDED` / `PLAYER_ALL_IN` | 行动记录；携带 actor、ActionSource、投入额及动作后的目标总投入 |
| `SHOWDOWN_STARTED` / `PLAYER_REVEALED` | 比牌 |
| `UNCALLED_BET_RETURNED` / `POT_AWARDED` | 未跟注筹码返还与逐 Pot 奖池分配动画 |
| `PLAYER_ELIMINATED` / `TOURNAMENT_FINISHED` | 锦标赛结果 |

- 事件同时服务：动画、Hand History、AI 历史、调试、断线恢复与未来 Replay（§6.12）。
- 事件由状态转移产生，顺序与状态转移一致；`sequence` 分配与 `Snapshot + Event Stream` 同步的信封与传输语义见 [02-protocol-spec.md](./02-protocol-spec.md) §6/§7（《总规划》§5.2）。
- **内部完整 vs 投影**：Engine 事件流是服务器内部完整流（可含 Burn 牌面等诊断信息）；面向玩家的 `PlayerView` 由 game-server State Projector 过滤，用户版 Hand History 只能展示该用户合法可见的信息（§6.12；《总规划》§5.3）。
- 超时自动动作使用同名的 `PLAYER_CHECKED` 或 `PLAYER_FOLDED` 事件，并以 `ActionSource = SYSTEM_TIMER` 标记；同样进入结构化 Hand History（§7.16）。

## 15. RNG 与可复现性（《区块6-10 v0.2》§6.13；《总规划》§9.1）

- 生产环境：使用**密码学安全随机源**洗牌与随机首局 Dealer。
- 测试环境：注入 `SeededRandomSource`，保证复杂牌局 100% 复现。
- Deck 顺序只存在于服务器内部，不能发送给客户端或 AI。
- Headless Simulator：用可注入随机 Seed 运行数千场 2–10 人比赛（发布前可提升到万级）；发现异常必须能按 Seed 100% 复现（机制权威见 [06-testing-strategy.md](./06-testing-strategy.md) §5）。

## 16. Failure Handling

| 失败场景 | 检测方式 | 处理 | 对调用方可见的结果 |
| --- | --- | --- | --- |
| 非法 Action（非本人回合 / 非法类型 / 金额越界 / 非整数） | Action Validation（§5.1） | 拒绝，**状态不变** | 错误码（码表见 [02-protocol-spec.md](./02-protocol-spec.md) §11） |
| 超时与 Action 同时到达 | game-server 以 `receivedAt` 与单调时钟裁决（§3.2） | `receivedAt <= actionDeadline` 的合法 Action 优先于超时任务；逾期 Action 不执行，返回 `ACTION_TIMEOUT` 或 `STALE_GAME_STATE` | Engine 只处理串行化后送达的 Action |
| 行动超时 | game-server Scheduler | Check 合法则 Auto Check，否则 Auto Fold（《总规划》§3.1）；以 `SYSTEM_TIMER` 源 Action 进入同一校验路径 | 自动动作进入 Hand History |
| 不限时模式 | 不创建行动超时任务（《总规划》§3.1）；断线宽限仍为 10 分钟（§4.1） | 无自动 Check/Fold（断线超 10 分钟走 §13 流程） | — |
| Critical Engine Error（负筹码、重复牌、Pot 无法结算、非法状态机） | Invariants 断言（§17） | **冻结当前 Hand、保存完整诊断信息、阻止进一步污染状态**；不猜测修复后继续（§8.10） | Hand 冻结 + 诊断 |
| 单参与者局部故障（断线/AI 失败/网络） | game-server 降级策略 | 只能降级该参与者，不能让整桌失去一致性（《总规划》附录 B 红线 5） | 牌局继续 |

除 `startTournament` 的首手 Dealer 抽签与 `startHand` 的洗牌外，Engine 状态转移必须是确定性的纯转移：相同 `GameState + Action` 恒产生相同 `GameState' + Events`。上述随机入口必须将已选择的 Dealer 与已洗好的 Deck 写入状态；在相同 Deck（或可恢复的 RNG 状态）下也必须 100% 可复现【设计意图】。

## 17. Invariants

| 不变量 | 表述 | 依据 |
| --- | --- | --- |
| 筹码守恒 | 在场筹码 + 未结算 Pot + `forfeitedChips` = 初始总筹码 | 《总规划》§4.1（取代旧式，见 §21 冲突 2） |
| 卡牌唯一 | 同一 Hand 中任意 Card 最多出现一次 | 《区块6-10 v0.2》§6.15 |
| 牌堆守恒 | 每手中已发底牌、公共牌、Burn Card 与剩余 Deck 构成初始 52 张牌的无重叠分区 | 本文 §7 |
| 筹码非负 | 任意 `Player.chips >= 0` | 同上 |
| Pot 非负 | 任意 Pot `amount >= 0` | 同上 |
| Actor 唯一 | 一个 Betting Round 最多一个 `currentActor` | 同上 |
| Fold 不可获奖 | Fold 后不能进入任何 Pot 的 `eligiblePlayers` | 同上 |
| Pot 可结算 | 每个 Pot 至少有两名 `contributors`、至少一名 `eligiblePlayers`，且全部金额可被确定性分配或按 §9 返还 | 本文 §9 |
| 淘汰/撤回不可行动 | `ELIMINATED` / `WITHDRAWN` 不再发牌、行动或缴盲 | §6.15；《总规划》§4.1 |

校验位置：测试环境在每个合法 Action 之后自动断言全部不变量（《区块6-10 v0.2》§9.8；机制权威见 [06-testing-strategy.md](./06-testing-strategy.md) §4）；运行时检测到违反即按 §16 Critical Engine Error 处理。

## 18. Security Considerations

- **规则唯一权威**：外部模块不得绕过 Engine 直接修改 `player.chips`、`pot`、`communityCards`、`dealerSeat` 等规则状态；所有牌局变更必须通过 Engine 的 Action Validation 与状态转移（《区块6-10 v0.2》§6.1；《总规划》附录 B 红线 1）。
- **输入校验**：所有外部输入必须校验；所有动作必须再次校验身份、回合、金额与合法性（红线 4）。
- **私有信息**：未公开 Hole Cards、Deck 顺序、Burn 牌面只存在于 Engine/Server 内部；State Projector 必须从源头删除未授权信息，严禁"先发送再用 CSS 隐藏"（《总规划》§5.3；红线 2）。
- **串行化**：同一 Tournament 的状态变更必须串行（红线 3）——由 game-server 保证；Engine 状态转移本身必须确定性纯转移（§16）。
- Engine **不负责**：Token/身份鉴权、Rate Limit、日志脱敏（game-server 职责，§8.7/§8.8/§8.11）。

## 19. Known Limitations

- 仅单桌 No-Limit Freezeout：无 Rebuy/Add-on/Bounty/MTT（《总规划》附录 A）。
- 2–10 人；P0 无 BOT，P1 加入 AI 不改写任何 Engine 规则（《总规划》§1/§8）。
- 不限时模式下仍保留 10 分钟断线宽限，牌局不会无限阻塞（《总规划》§4.1）。
- 服务进程崩溃后的进行中 Hand 无损恢复**不是** P0 硬要求（《总规划》§7.2）。
- 不包含 AI 决策所需数学（Equity、Pot Odds 等属 `poker-math`，P1；《总规划》§8）。
- 不涉及并行多桌与分布式状态（单实例模块化单体；《区块6-10 v0.2》§7.20）。
- 高风险规则（Short All-in、最小加注、Raise 权重开）最易产生隐蔽 Bug，是 P0 测试最高优先级（《区块6-10 v0.2》§6.8）。

## 20. 原待决项的最终裁决

本文没有剩余待决项：#1 Time Bank 单次最多延长 30 秒且每个行动机会最多成功一次；#2 有限时档位固定为 `15/20/30/45/60` 秒，另允许 `UNLIMITED`。规范落点见 §12；UI 与 Scheduler 同步见 [05](./05-frontend-spec.md) §6.2 和 [04](./04-game-server-architecture.md) §8.3/§8.4。

## 21. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 断线退出 | 《区块1-5 v0.1》§4.8："第一版不因断线时间过长强制淘汰" | 《总规划》§4.1：断线满 10 分钟 → `EXIT_PENDING` → `WITHDRAWN` + `forfeitedChips` | 以《总规划》为准（新决策） |
| 2 | 筹码守恒不变量 | 《区块6-10 v0.2》§6.15："玩家筹码 + 未结算 Pot = 比赛总筹码" | 《总规划》§4.1："在场筹码 + 未结算 Pot + `forfeitedChips` = 初始总筹码" | 以《总规划》为准 |
| 3 | Time Bank 消耗方式 | 《区块6-10 v0.2》§7.15："按 20/30 秒一段消耗，具体由最终 UI 配置确定" | 《总规划》§3.1："一次延长当前行动的固定时段（例如 30 秒）或剩余余额中较小者" | 以《总规划》为准 |

### 本轮工程定稿补充（2026-08-21）

以下事项为上游规划未明确、但 Engine 实现与测试不能悬置的工程裁决。后续产品规则若作出相反决策，必须同时更新本表及所列章节。

| # | 裁决 | 落点 |
| --- | --- | --- |
| 1 | 所有筹码金额使用整数；`LegalActions` 明确 Bet、Call、完整 Raise 与 All-in 的能力、目标额和上限 | §4/§5/§8/§12 |
| 2 | Short All-in 对未行动者保留 Raise 权；已行动者以“自上次决定以来累计达到完整加注幅度”判定是否重开 | §8.3 |
| 3 | 未被跟注的顶层贡献逐层退回；Odd Chip 在每个 Split Pot 中独立按 Dealer 左侧顺时针分配 | §9 |
| 4 | 首手 Dealer 的候选资格、逐张底牌发放顺序、冠军的 `ACTIVE` 资格均由本文明确 | §7/§11/§12 |
| 5 | `WITHDRAWN` 使用 Tournament 级指令；自动动作沿用常规 Action Event 并标注 `SYSTEM_TIMER`；Config 校验规则归 Engine | §12/§13/§14 |
| 6 | 随机入口把结果写入状态，以保证后续状态转移与 Replay 完全确定 | §15/§16 |

《总规划》v1.0 新增、docx 未覆盖的决策（本文已吸收）：允许盲注下降且每 Level 独立校验（§2.3）；不限时强制禁用 Time Bank 且协议不接受 `USE_TIME_BANK`（§3.1）；Action 与超时竞争的四步裁决（§3.2）；P0 开局条件 ≥2 真人（§2.1）；同手多淘汰 `seatIndex` 稳定排序（§2.1）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。
