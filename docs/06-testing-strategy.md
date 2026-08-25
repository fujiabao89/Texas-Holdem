# 06 · 测试方案与发布门槛（`tests/`）

> 状态：草稿（实施基线 v0.5；测试基础设施已按 TEX-12 落地，持久化 Integration 已按 TEX-18 落地，Headless Simulator 长跑已按 TEX-16 落地，其余业务测试随对应任务回填）
> 规划核对：2026-08-21（TEX-12 基线）；2026-08-23（TEX-18 持久化 Integration 落地）；2026-08-24（TEX-16 Headless Simulator 落地）——其余章节在对应任务落地前仍为**设计意图**
> 权威范围：本文是测试体系的唯一权威来源——测试分层与归属、确定性回归集、P0 必测范围矩阵、Invariant 自动断言、Headless Simulator、联机/重连/投影安全测试范围、P1 AI 测试、UI E2E 与人工验收组织、性能与监控指标、CI 分层与门禁、缺陷分级处理与发布门槛。范围之外的事实见对应文档：规则语义 [01](./01-engine-spec.md)、协议与错误码 [02](./02-protocol-spec.md)、持久化 [03](./03-data-model.md)、服务端运行时行为 [04](./04-game-server-architecture.md)、前端交互与验收界面 [05](./05-frontend-spec.md)。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§9/§10）；《德州扑克项目规划_区块6-10_v0.2.docx》§9/§10（仅在《总规划》未覆盖处补充）
> 对应代码：`tests/`（support/meta/e2e/simulator，TEX-12 已落地）、根 `vitest.config.ts`（分层配置）、`tests/e2e/playwright.config.ts`（E2E）、各包内 `*.test.ts`
> 上级索引：[工程文档总索引](./README.md)

> **【设计意图 · 未实现】** 本文同时包含上游规划要求和为使其可执行而新增的工程基线；后者以“工程基线”标识，不反向改变 01–05 的业务语义。实现落地后须逐条回填真实命令、耗时与覆盖状态；任何偏离均应先更新本文或记录 ADR，不得让 CI 与文档长期分叉。当前测试策略 TBD 已全部裁决，记录见 §15。

## 1. Purpose 与测试优先级

规则正确性是本产品的核心价值：P0 级缺陷（错误发牌、重复牌、Pot/赢家错误、私密底牌泄露、比赛死锁）直接禁止上线（《总规划》§9.2）。测试优先级据此排序（《区块6-10 v0.2》§9.1）：

1. Poker Engine 规则测试、状态一致性（Invariant）与随机长跑——最危险的是极端牌局状态错误；
2. 联机/WebSocket/重连与投影安全测试；
3. UI E2E；动画流畅度与下注体验必须在 Release 阶段做真实设备人工验收。

测试与交付路线绑定（《总规划》§10；与《区块6-10 v0.2》§10.12 的 10 阶段顺序兼容）：先 Engine 与规则测试/Simulator（步骤 1–2），联机与服务端测试随步骤 3–4，实机 E2E、稳定性与安全测试在步骤 6 收口；P1 AI Scenario 测试在步骤 7。原则："漂亮 UI 不应该早于核心规则稳定"（《区块6-10 v0.2》§10.13）。

## 2. 测试分层与职责

分层顺序（《区块6-10 v0.2》§9.1）：

```text
Unit Test → Poker Rule Test → Integration Test → Multiplayer/WebSocket Test
→ E2E Test → Long-running Simulation + Manual UI/Animation/UX Review
```

| 层次 | 范围 | 归属（规划） | 框架与命令 | 本文章节 |
| --- | --- | --- | --- | --- |
| Unit Test | 纯函数与独立模块（Hand Evaluator、金额计算、`TournamentConfig` 校验等） | 与源码同包的 `*.test.ts`，以及 `apps/*/tests/unit`、`tests/support`、`tests/meta` | Vitest；`pnpm test:unit`【工程基线，TEX-12 已落地】 | §3.1 |
| Poker Rule Test | Engine 规则正确性（下注/Pot/淘汰/事件） | `packages/poker-engine/tests/**/*.test.ts` | Vitest + fast-check；`pnpm test:rules`【工程基线，TEX-12 已落地；引擎落地前受控跳过】 | §3.1/§4 |
| Integration Test | Engine × 串行执行器 × Scheduler × 持久化 | `apps/game-server/tests/integration` | Vitest + 隔离测试库；`pnpm test:integration`【工程基线，TEX-12 已落地；持久化用例（迁移/控制面/Commit Bundle/约束/最小权限）已按 TEX-18 落地，缺测试库配置时受控跳过】 | §3.2/§6 |
| Multiplayer/WebSocket Test | 多客户端一致性、Snapshot/Event、重连 | `apps/game-server/tests/ws` + `tests/clients/` | Vitest + 可编程 WS 客户端；`pnpm test:ws`【工程基线，TEX-12 已落地；WS 实现落地前受控跳过】 | §6 |
| E2E Test | 完整用户旅程（创建房间 → 完赛） | `tests/e2e/` | Playwright + axe-core；`pnpm test:e2e`【工程基线，TEX-12 已落地（含冒烟与失败产物）；业务旅程随前端任务回填】 | §9 |
| Long-running Simulation | 随机长跑与不变量自动断言 | `tests/simulator/`（模块自测归 unit 层） | 独立 Node CLI；`pnpm test:sim -- --seed ...` / `--tier smoke\|nightly\|rc`【已落地 · TEX-16：长跑主循环、每转移不变量断言、Watchdog、Smoke/Nightly/RC 三档与失败产物】 | §5 |
| Load / Soak Test | 多 Room/WS、突发命令、重连风暴与稳定性 | `tests/load/` | Artillery；`pnpm test:load`【工程基线，未实现】 | §10 |
| Manual UI/Animation/UX Review | 真实设备人工验收 | 人工 | 不适用 | §9 |

上游规划未指定测试工具；上表为基于既定 TypeScript/pnpm 技术栈作出的工程基线。根脚本必须作为唯一公共入口，包内命令可调整，但 CI、本地和文档不得各自维护不同命令。分层入口的落地事实（2026-08-21，TEX-12）：根 `vitest.config.ts` 以互斥 include 定义 unit/rules/integration/ws 四层（`pnpm test` 为 Vitest 层总入口），E2E 与 Simulator 分别为 Playwright 与独立 CLI；`tests/support/` 提供 Seed 解析、确定性 PRNG、Fake Clock、Fixture Builder 与测试数据库隔离工具（自带自测），`tests/meta/` 守护入口与分层互斥性；空层以 `passWithNoTests` 成功退出并明确输出未发现测试，不伪造结果。

### 2.1 测试可重复性与隔离原则【工程基线】

- Engine 测试不得读取系统时间或非注入式随机源；随机、时钟、ID 与 Scheduler 均可替换，失败必须能由 Seed + Fixture 重放。
- Integration 使用独立数据库 Schema/实例与唯一 `runId`；每例自行创建并清理数据，不依赖执行顺序，不共享可变 Tournament。
- 涉及时序的测试使用 Fake Clock/受控 Scheduler，不以任意 `sleep` 证明正确性；真实网络 E2E 仅在确需验证浏览器/网络栈时等待可观察条件。
- 持久化 Integration 使用与生产兼容的真实 PostgreSQL；DeepSeek、Supabase 托管 HTTP API 等进程外网络依赖默认使用契约一致的 Fake，并另设少量受控 Sandbox Contract Test。PR 门禁不得依赖不稳定的第三方网络。
- 重试只能用于采集诊断，不能把“重试后通过”记为门禁通过；Flaky 用例等同失败，须修复或经负责人书面批准后带期限隔离。

### 2.2 覆盖率与状态覆盖【工程基线】

| 范围 | 最低门槛 | 补充要求 |
| --- | --- | --- |
| `packages/poker-engine` | 行 ≥95%，分支 ≥90% | §3.1 列出的规则分支与合法状态迁移 100% 有确定性用例；不得以覆盖率替代规则断言 |
| `packages/protocol` 投影/Schema | 行 ≥95%，分支 ≥90% | 每种消息、错误码和接收者角色均有正反契约用例 |
| 其他 P0 代码 | 行 ≥80%，分支 ≥75% | 新增/修改代码不得降低包级门槛 |

覆盖率排除项必须在配置中逐项写明理由；生成代码、纯类型声明可排除，业务分支不可通过忽略标记绕过。

### 2.3 第三方 Sandbox Contract Test【工程基线】

Sandbox Contract Test 是使用第三方服务的**真实非生产账号/项目**发起少量请求，验证认证、连接、请求/响应 Schema、权限和错误映射仍符合本项目假设。它处在 Fake 测试与生产之间：Fake 负责快速、确定地穷举成功/失败分支；Sandbox 负责发现第三方 API 漂移、密钥/网络/权限配置错误；它不读取生产数据、不验证容量，也不替代 AI 策略质量测试。

| 服务 | 隔离与测试内容 | 频率与额度 | 凭证管理 |
| --- | --- | --- | --- |
| Supabase | 独立非生产 Project + 私有测试 Schema；执行迁移、连接、事务回滚、最低权限/RLS 与原始表不可访问测试；每次运行后按 `runId` 清理 | 主分支每日一次 + 每个 Release Candidate；使用免费或最低付费档，禁用自动付费超额，资源达到套餐 70% 告警 | game-server 专用最小权限 Role；连接串只进入受保护的 `sandbox` CI Environment |
| DeepSeek（P1） | 独立测试 Key；验证认证、超时配置、结构化输出可解析、Token 统计与错误映射；策略质量仍按 §8 的 80 场景执行 | 每周一次 + 每个 P1 Release Candidate；每次最多 100 请求，月度硬预算 ¥50，达到 70% 告警并停止非 RC 运行 | Key 只进入受保护的 `sandbox` CI Environment；Fork PR/普通 PR 不注入 |

所有 Sandbox Secret 由总负责人管理，GitHub Actions 日志必须 Mask；至少每 90 天轮换，疑似泄露立即吊销。Sandbox Job 只允许受保护主分支、定时任务和经批准的 Release Environment 使用。Sandbox 不稳定只阻断依赖该服务的 Release Candidate，不得让 P0 核心牌局测试变成第三方网络依赖。

## 3. P0 必测清单（范围矩阵）

合并《总规划》§9.1 必测项与《区块6-10 v0.2》§9.2–§9.8 分类细节。规则语义的权威来源是 01–05，本文只定"测什么、在哪层测"，不重述规则本身。

### 3.1 Engine 规则（权威：[01](./01-engine-spec.md)）

| 必测项 | 层次 | 规格来源 |
| --- | --- | --- |
| Deck：52 张唯一、Shuffle、Hole/Board/Burn 不重复 | Unit / Rule | 01 §7 |
| Burn 标准发牌顺序 `Hole×2 → Burn → Flop×3 → Burn → Turn → Burn → River`；Burn 牌面永不进入 PlayerView/BotView | Rule + 投影 | 01 §7；[02](./02-protocol-spec.md) §9 |
| Dealer/Blind：首局随机、顺时针移动、跳过淘汰/退出、Heads-Up | Rule | 01 §11 |
| 全部动作序列：Check/Call/Bet/Raise/Re-Raise/All-in | Rule | 01 §8.1 |
| Raise 边界：min/max Raise、Short All-in（多序列，非单一 Case）、Call All-in（剩余 < `callAmount`）、Raise 权重开 | Rule | 01 §8.2–8.4 |
| Pot：普通 Pot、单/多 Side Pot、Fold 贡献、Split Pot、Odd Chip | Rule | 01 §9 |
| Evaluator：全部牌型、同牌型内部比较（Pair Kicker、Two Pair 高低对、Full House trips、Flush 逐张、Straight 最高张）、A2345、Board Plays | Unit / Rule | 01 §10 |
| Tournament：淘汰、同手多人淘汰（本手开始 Stack + `seatIndex` 稳定排序）、盲注变更边界（计时到期 → 下一手生效；按手数升盲边界）、Heads-Up 切换、唯一 Champion | Rule | 01 §12 |
| 下降盲注：每 Level 独立校验、不继承上一手最小加注幅度 | Rule | 01 §8.2/§12 |
| 不限时模式：无行动超时任务、不自动 Check/Fold、`USE_TIME_BANK` 被拒绝 | Integration | [04](./04-game-server-architecture.md) §8；《总规划》§3.1 |
| Time Bank：基础时间 + 银行组合、`timeBankRemainingMs` 扣减、多次使用/用尽/超额请求、用尽后 Auto Check/Fold、断线不自动消耗 | Integration | 04 §8 |
| 超时竞争裁决：`receivedAt <= actionDeadline` 的合法 Action 优先；逾期返回 `ACTION_TIMEOUT`/`STALE_GAME_STATE` 且不执行 | Integration | 04 §7.2；02 §11 |

### 3.2 联机与服务端（权威：[04](./04-game-server-architecture.md) / [02](./02-protocol-spec.md)）

| 必测项 | 层次 | 规格来源 |
| --- | --- | --- |
| Room/邀请码：创建、邀请码唯一、错误/过期、Room Full、昵称重复、加入/离开/换座、Ready、Host 权限与转移、开局锁定（开始后禁止增员/改核心配置）、邀请码枚举限流 | Integration | 04 §5/§10.3；《总规划》§2.1 |
| 离开与断线：主动离开、断线满 10 分钟 `EXIT_PENDING → WITHDRAWN`、无真人 `CLOSED`/`ABANDONED_NO_HUMAN` | Integration | 04 §6.6/§9.3；01 §13 |
| WebSocket 异常：重复 `requestId/actionId` 返回原结果、幂等键换 Payload 被拒、缺失/重复 sequence、旧状态 Action、多设备接管与 Close 4001 | Multiplayer | 02 §7/§10/§12/§14 |
| Snapshot 屏障：Snapshot `S` 后首个 Event 必为 `S+1`；建 Snapshot 时并发动作不丢失；sequence 十进制字符串跨安全整数仍精确 | Multiplayer | 02 §4.1/§6.4 |
| 多客户端一致性：公开状态一致、私有信息按 PlayerView/Patch 隔离；逐事件 `apply(before, patch) == after`；Event 丢失/重复时客户端重取 Snapshot 而非继续错误应用 | Multiplayer | 02 §6.3/§9/§14 |
| 心跳：15 秒 Ping、45 秒无活动断开、正常 Pong 不误断；后台恢复走完整 Snapshot | Integration / Multiplayer | 02 §4.3/§10 |
| 重连：刷新、Wi-Fi/蜂窝切换、后台恢复；恢复原 Seat/Stack/Hole Cards/Board；不重播旧动画 | Multiplayer / E2E | 02 §10；04 §9 |
| 持久化 Writer：整手 Commit Bundle 单事务、失败回滚、同 ID/Sequence 重试、乱序完成保护、soft/hard watermark 与 DB 恢复后续写 | Integration | [03](./03-data-model.md) §7/§10；04 §12/§16 |
| 崩溃恢复：首手/进行中 Hand/Bundle 提交前后崩溃、孤立 Snapshot、事件缺口、checksum/版本错误；只从最新可验证检查点恢复 | Integration / Recovery | 03 §4.3/§7；04 §13 |
| 数据访问隔离：迁移后 `anon`/`authenticated` 无法读取或写入原始表，game-server Role 仅具最小权限 | Integration / Security | 03 §9 |
| 投影字段级安全测试 | 自动化安全 | §7 |

### 3.3 前端（权威：[05](./05-frontend-spec.md) §16）

> TEX-23/TEX-24 已补充前端基础与 Lobby Unit/E2E 测试：HTTP 成功/错误 Schema、Fake Clock 驱动 timeout、取消、Token 的同 Tab 恢复/安全清除与 storage 降级、WS 认证/幂等/`appliedSequence` pending 回收、Snapshot 覆盖、连续 Patch、乱序重同步、邀请链接预填和 Home 双入口的 a11y 回归。完整多浏览器多人联调继续由 TEX-28 落地。

| 必测项 | 层次 | 规格来源 |
| --- | --- | --- |
| UI E2E：创建房间、邀请码加入、Ready、完成一手牌、完整 Tournament；下注无键盘（1/3 Pot、1/2 Pot、2/3 Pot、Pot、All-in、Slider、±）；普通 Raise Slider 范围为 `[minRaiseTo,maxRaiseTo]`，到达 `allInTo` 转独立 All-in 两步并提交 `ALL_IN`，Short All-in 不伪装成 Raise | E2E | 05 §8/§16 |
| 动画与音效人工验收（Deal/Burn/Board/Showdown 剧本） | Manual | 05 §16 |
| 响应式与实机矩阵（约 390×844 / 360×800 / 平板 / 1366×768 / 1920×1080；10 人桌不重叠） | Manual / E2E | 05 §16 |
| 可访问性：WCAG 2.2 AA、键盘主流程、焦点管理、名称/状态、对比度、Reduced Motion 终态一致 | Automated A11y / E2E / Manual | 05 §7.6/§16 |

### 3.4 确定性回归集【工程基线】

随机长跑不能替代已知边界的固定用例。`tests/fixtures/` 保存人类可读的初始状态、Action 序列和期望事件/终态；每个生产缺陷在修复前必须先增加一个能失败的最小 Fixture，并记录缺陷号与原始 Seed（如有）。P0 最低回归族如下：

| 回归族 | 最低固定场景 |
| --- | --- |
| Raise 权重开启 | 完整 Raise 后 Short All-in 不重开；随后 Call；多次 Short All-in 累计达到完整 Raise；Heads-Up 变体 |
| Pot/Side Pot | 单 Side Pot、三级 Side Pot、Fold 有贡献、多人 All-in 不同深度、主/边池不同赢家、Split + Odd Chip |
| Evaluator | 每种牌型边界、A2345、Board Plays、所有 Kicker 比较、完全平局 |
| Dealer/Blind/Tournament | Heads-Up Button/Blind、跳过淘汰/撤回、同手多人淘汰排序、升/降盲边界、唯一 Champion |
| 时间与并发 | Deadline 前/等于/后 Action、Timer 先后入队、重复 `actionId`、旧 `expectedSequence`、多设备接管 |
| 投影与重连 | 每种角色的 Snapshot/Event、缺序/重复/未知 Patch、Fold 后底牌隐藏、重连不重播动画 |

Fixture 必须通过公开的 Engine/协议入口执行，不得直接篡改被测模块内部状态；确需构造不可由正常开局快速到达的状态时，使用经过 Schema 校验的 Test Builder。

## 4. Invariant 自动断言

- 机制：测试环境在**每个合法 Action 之后**自动断言全部 Engine Invariants（《区块6-10 v0.2》§9.8）。
- 不变量定义与清单的权威在 [01](./01-engine-spec.md) §17：筹码守恒、卡牌唯一、筹码非负、Pot 非负、Actor 唯一、Fold 不可获奖、淘汰/撤回不可行动。
- 筹码守恒公式以《总规划》§4.1 为准：**在场筹码 + 未结算 Pot + `forfeitedChips` = 初始总筹码**（取代《区块6-10 v0.2》§6.15 旧式，见 01 §21 冲突 2）。
- 与运行时行为的关系【设计意图 · 未实现】：测试自动断言与运行时 Critical Engine Error 检测（01 §16）应复用同一套不变量实现，挂载两处。
- 随机长跑（§5）中每个合法 Action 后执行同一断言（《总规划》§9.1）。
- 断言时点【工程基线】：初始化后、每个合法 Action 后、每次 Timer/退出等服务端合成 Action 后、每手结算后、序列化/反序列化往返后均执行；非法 Action 被拒后另断言状态与 sequence 未改变。
- 除 Engine Invariants 外，Integration 同步断言 [04](./04-game-server-architecture.md) §16 的串行唯一、幂等、序列单调、单活跃连接、手末提交完整等服务端不变量。

## 5. Headless Simulator / 随机长跑（Poker Fuzzer）

> 实施状态（2026-08-24，TEX-16）：本节已实现于 `tests/simulator/`——加权场景生成（2/3/10 人、深浅筹码、三种 Blind Mode、盲注升降、多人 All-in/Fold 到底/Heads-Up）、只从 Engine `LegalActions` 选动作的代理、每次状态转移与每手结束后的不变量断言（复用引擎 `assertInvariants`/`assertTournamentInvariants`）、事件序列完整性、Watchdog（50,000 action / 30s / 1,000 转移）、Smoke/Nightly/RC 三档种子规划、失败产物（seed 重放命令 + 场景 fixture + 完整轨迹 + 统计摘要）与覆盖统计零检测。运行方式见 [tests/simulator/README.md](../tests/simulator/README.md)。失败 seed 的**自动缩减**尚未实现：当前由人工确认后加入 `tests/simulator/known-seeds.ts` 回归集（现为空集）。

- 实现 Headless Simulation Runner（《区块6-10 v0.2》§9.9）：创建 2–10 人 Tournament，每次从 Engine `LegalActions` 中选择动作，持续到唯一 Champion。生成器须对 2/3/10 人、深浅筹码、Short All-in、多人 All-in、Fold 到底、Heads-Up、升/降盲边界做加权覆盖，不能只做均匀随机。
- 分层规模【工程基线】：PR Smoke 运行已知失败 Seed 回归集，并从提交 SHA 确定性派生 ≥200 个新 Seed；Nightly 每个受支持 Blind 模式合计 ≥10,000 场；Release Candidate 自候选提交起累计 ≥50,000 场且至少包含 10,000 个此前未运行的 Seed。计数仅包含走到唯一 Champion 且所有断言通过的完整 Tournament，Seed 范围必须写入报告。
- 可复现性：每场保存 `randomSeed`；任何长跑发现的死锁、Side Pot mismatch 或 Invariant violation 必须能用同一 Seed 100% 重放（《总规划》§9.1；《区块6-10 v0.2》§9.9）。测试环境注入 `SeededRandomSource`（01 §15）。
- Watchdog【工程基线】：单场超过 50,000 个 Action、30 秒测试进程时间，或连续 1,000 次状态转移未完成一手牌，均按 Liveness Failure 失败并保存现场；阈值可依据基准调整，但 Release 前必须冻结并记录。
- 输出：失败时保存 Engine/配置版本、Seed、初始配置、完整 Action/Event/Board 轨迹、失败前后状态、Invariant 名称和最小化后的复现 Fixture；成功运行只保存聚合统计，避免日志淹没信号。
- 可复现的前提是 Engine 状态转移为确定性纯转移：相同 `GameState + Action` 恒产生相同 `GameState' + Events`（01 §16）。
- 覆盖反馈【工程基线】：报告玩家数、牌局阶段、动作类型、牌型、Pot 数量、All-in 人数、Heads-Up、盲注变更和结束原因的分布；某类为零视为生成器覆盖失败。发现的失败 Seed 经自动缩减后加入 §3.4 固定回归集。
- 非法/恶意输入不由 LegalActions Fuzzer 覆盖：另设 Protocol/Action Fuzzer 生成缺字段、未知字段、越界金额、非法枚举、超大 Payload、重复/乱序信封，断言安全拒绝、无状态变化且错误响应不泄密。

## 6. 联机与重连测试

TEX-23 在 `apps/web/src/{protocol,state}/**/*.test.ts` 使用可注入 Fake WebSocket、UUID 与 Fake Clock 先验证客户端消费边界；它们属于 Unit 层，不替代服务端 `tests/clients/` 多客户端联机测试。

- 多客户端测试：同一 Tournament 的多个测试客户端必须收到一致的公开状态；每个 sequence 应满足 `apply(previousView, patch) == serverProject(state, viewer)`，私有信息按 PlayerView 隔离（§7）；覆盖 Event 丢失、重复、乱序、未知字段、断连中积压、过期 Action、`actionId` 重复，并断言客户端**重新同步而非继续错误应用**（《区块6-10 v0.2》§9.11）。
- 故障注入【工程基线】：测试代理可确定性地 drop/duplicate/delay/reorder/close WS 帧；每个用例记录故障脚本和 Seed。协议级测试不用真实移动网络，真实设备 Release 验收再覆盖 Wi-Fi/蜂窝切换。
- 重连矩阵：刷新；Wi-Fi/蜂窝切换；后台 20 秒返回；断线期间零个/一个/多个他人 Action；行动中断线；Showdown/手末断线；旧连接与新连接并发提交；断线满 10 分钟前后。恢复必须得到最新 Snapshot、原 Seat/Stack/合法可见 Hole Cards/Board，且不重播旧动画。
- 幂等断言：重复 `actionId` 复用原结果且至多改变一次筹码/sequence；同 ID 不同 Payload 安全拒绝；进程内重连后仍幂等。进程重启后的边界按 [02](./02-protocol-spec.md) §7.3 契约测试。
- Reconnect Stress 属 Nightly 阶段（§11）。
- 测试覆盖的协议不变量（序列单调、幂等执行、投影完整、单活跃连接、计时权威）定义见 02 §14 / 04 §16。

## 7. 私有信息字段级安全测试（投影）

- 使用“允许字段 Schema + 权威投影逐字段相等”作为主断言，递归禁用未知字段；禁用字段名清单只作为第二道防线，不能因字段改名而失效。
- 至少在四层验证：投影函数返回对象、Schema 序列化后的 HTTP/WS 原始 Payload、客户端实际收到的数据、日志/错误响应/诊断事件。Bob 的任何层均不得出现 Alice 未公开底牌、Deck、Burn Card 牌面或服务端私密字段；P1 的 Bot A Context 不含 Bot B 私有底牌、内部 Memory 或 Reasoning。
- 使用每位玩家不同的哨兵值构造牌与 Token，并扫描序列化字节，避免只检查顶层键；同时断言合法公开牌和本人底牌没有被过度删除。
- 角色矩阵覆盖当前 Actor、非 Actor、Fold 玩家、All-in 玩家、淘汰观战者、断线/重连玩家、P1 Bot；事件矩阵覆盖 Deal、Burn、各 Street、Showdown、Fold 后手末与 Hand History。
- 错误路径必须测试：Schema 校验失败、非法 Action、过期状态、限流、内部异常、Critical Engine Error 的外部响应均不得含堆栈、SQL、Token、Deck 或其他玩家私密信息。
- 存储边界另按 §3.2 使用最低权限角色做黑盒测试，确认浏览器可用角色无法绕过投影直接查询原始 Event/Snapshot；日志脱敏测试必须覆盖 Token、DeepSeek Key、牌堆和未公开底牌。
- 投影契约的权威在 [02](./02-protocol-spec.md) §9；投影完整不变量在 02 §14 / [04](./04-game-server-architecture.md) §16。
- 客户端侧配合断言（收到的 Payload 无未授权字段）见 [05](./05-frontend-spec.md) §15。

## 8. P1 AI 测试

P1 才启用（《总规划》§8）；P0 不接 AI API、不显示 AI 控件（《总规划》§6）。

| 场景 | 预期 | 依据 |
| --- | --- | --- |
| 正常结构化 Action | 过 JSON Schema + Legal Action 校验后执行 | 《区块6-10 v0.2》§9.14 |
| Timeout / HTTP 500 | 本地 Fallback，牌局不停 | 同上 |
| Invalid JSON | 解析失败 → Fallback | 同上 |
| 非法动作 / Too-small Raise | Validator 拒绝 → Fallback/重试 | 同上 |
| 超长输出 | 输出限制，不影响核心牌局 | 同上 |
| AI 决策质量 | 固定 Poker Scenario Set（50–100 典型局面），断言困难 AI 落在合理策略范围；目标是避免明显荒谬行为（如 AKs BTN 深筹码无人入池却经常 Fold），不要求唯一动作；重复运行允许策略随机性，但不出现大比例无逻辑 All-in | 《区块6-10 v0.2》§9.15 |

AI 接入边界见 04 §14（AI 只能选择 Engine 合法 Action）；成本与监控指标见 §10。

### 8.1 AI Scenario Set 与量化门槛【工程基线】

- 固定 **80 个**场景：Pre-Flop/Flop/Turn/River 各 20 个；每组覆盖位置、有效筹码深度、Pot Odds、多人 Pot、Draw、Made Hand、Short Stack、Bubble/Heads-Up 与明显 Fold/Call/Raise/All-in 边界。Fixture 固定公开信息、BotView、LegalActions 和允许/禁止动作集合，不向模型暴露对手底牌。
- 每个候选模型版本、Prompt 或关键参数组合对每个场景独立运行 **30 次**（共 2,400 次）；固定模型标识、Prompt 版本和采样参数并保存响应摘要。任一项变化均视为新候选，旧结果不可复用。
- 全量 2,400 次质量集在 P1 阶段每周及每个 Release Candidate 运行；PR 只运行 Validator/Fallback Fake 与固定响应回归，不调用真实模型。达到 70% 预算先停止非 RC 周期运行；若剩余额度不足以完成 RC 门禁，则等待预算周期重置或由总负责人明确批准一次性上调，不能跳过测试。
- 正常服务下，原始响应 JSON Schema 通过率 ≥99%；Schema/合法性失败必须走 Fallback，且正常服务下 Fallback Rate ≤1%。经 Validator/Fallback 后最终送入 Engine 的 Action 合法率必须 =100%；任何非法 Action 实际进入 Engine 均为 P0 失败。
- 每个 Fixture 明确 `allowedActions`、`discouragedActions` 与 `forbiddenActions`。禁止动作在全部样本中的聚合比例 ≤2%，任一单场景 ≤10%；标记为“无逻辑 All-in”的动作聚合比例 ≤1%，且任一单场景不得超过 1/30。超过门槛即 P1 阻断，不用其他场景的好成绩抵消。
- 哨兵场景“BTN、100BB、前位无人入池、AKs”中 Fold ≤1/30、All-in ≤1/30，Raise 占比 ≥90%；这是防止明显退化的下限，不宣称唯一最优策略。
- Scenario 标签由工程维护并在首次建立及策略规则改变时交总负责人确认；失败必须保存模型/Prompt 版本、场景 ID、原始输出的安全摘要、Validator/Fallback 结果和统计报告。不得保存或展示供应商隐藏 Reasoning。

## 9. UI E2E 与人工验收

- E2E 覆盖创建房间、邀请码加入、Ready、完成一手牌与完整 Tournament；P1 增加单人开局（《区块6-10 v0.2》§9.16）。
- 前端验收标准表的权威在 [05](./05-frontend-spec.md) §16（下注无键盘、All-in 两步、动画剧本、响应式矩阵、重连、信息隔离），本文不重述。
- 动画与音效为人工验收：Showdown 剧本（Reveal → Best Five → 牌型 → Winner → Pot）是重点场景（《区块6-10 v0.2》§9.17）。
- E2E 使用稳定的角色/语义定位和专用测试 API 构造状态；不得依赖 CSS class、固定文案或大量点击把比赛随机推进到目标状态。测试 API 仅在测试环境启用且必须通过正常 Engine 入口提交 Fixture。
- 每个页面和关键 Dialog 运行 axe-core 自动扫描；创建/加入/Ready/下注/离开主流程另以纯键盘执行，并断言焦点进入/返回、可见焦点、可访问名称、`aria-live` 节制与 Reduced Motion 下相同业务终态。自动扫描通过不替代真实键盘、读屏抽查和颜色对比人工验收。
- 失败时自动保留浏览器 Trace、截图、视频、Console、Network/WS 摘要与服务端关联 `runId`；任何未处理 Console Error、Page Error、请求 5xx 均使测试失败，明确列入白名单者除外。
- Release 人工验收须记录候选版本、设备/OS/浏览器版本、场景、验收人、时间和证据链接；“可接受”不能只有口头结论。设备矩阵见 §9.1。

### 9.1 Release 设备与浏览器矩阵【已裁决】

“当前版本”指切出 Release Candidate 当日的 Stable 版本，证据包必须记录准确版本号；浏览器在候选测试期间升级后，至少重跑该浏览器关键 E2E。

| 类别 | 最低设备/环境 | 浏览器与视口 | 验收范围 |
| --- | --- | --- | --- |
| 中低档 Android 实机 | Android 12+、4 GB RAM、Snapdragon 680/Helio G80 或同等级 CPU；若更换机型不得提高最低性能档 | 当前 Chrome Stable；360×800 CSS px 左右 | 完整比赛、下注、动画/音效、后台恢复、Wi-Fi/蜂窝切换、性能与触控 |
| iPhone 实机 | iPhone 15，当前 Stable iOS | Safari；约 393×852 CSS px | 与 Android 相同，另验收 Safari 音频解锁、Safe Area 和返回前台 |
| Windows 桌面实机 | 当前受支持 Windows | Microsoft Edge Stable；1366×768 与 1920×1080 | 完整主流程、10 人桌布局、键盘/焦点、动画与重连 |
| 桌面自动化 | CI 的当前 Playwright Stable | Chromium、Firefox、WebKit；1366×768 与 1920×1080 | 全量关键 E2E、响应式、可访问性与截图回归 |

浏览器模拟和 CPU Throttling 可用于日常回归，但不能替代 Android 与 iPhone 15 实机发布验收。

## 10. 性能、成本与监控

- 性能测试优先验证：单桌 10 人（P1 含 9 AI）、多个并行 Room、前端动画掉帧、WebSocket 状态一致（《区块6-10 v0.2》§9.19）。所有服务端延迟从命令通过 Schema/身份校验进入服务端开始，到对应 Event 完成投影并写入 WS 为止，不包含公网 RTT；测试报告必须注明机器规格、版本、数据规模与运行参数。
- DeepSeek 统计：平均 Input/Output Tokens、Latency、Fallback Rate、每场 Tournament 成本（《区块6-10 v0.2》§9.19；《总规划》§8）。
- 上线监控指标（《区块6-10 v0.2》§9.19）：Active Rooms/Tournaments、Active WebSockets/Reconnect Rate、AI Request Count/Latency、AI Timeout/Fallback Rate、Action Rejection Rate、Game Error/Invariant Violation（核心 P0 监控）。

### 10.1 P0 初始性能门槛【工程基线】

P0 容量目标固定为单实例 **100 Room / 1,000 WS**；首轮基准不以“机器较慢”为由降低目标，确需改变须由总负责人批准并记录容量/成本权衡。

| 场景 | 负载与持续时间 | Release 门槛 |
| --- | --- | --- |
| 正常牌局 | 单实例 100 Room × 10 WS，持续 30 分钟 | Action→Event p95 ≤250 ms、p99 ≤500 ms；业务 5xx/意外断连 <0.1%；Invariant violation = 0 |
| 突发行动 | 1 秒内 500 个命令分布到 ≥50 Room | p99 ≤1 s；同桌 sequence/幂等/投影断言全部通过 |
| 重连风暴 | 1 分钟内 500 个连接重连 | 认证至首个完整 Snapshot p95 ≤1 s、p99 ≤2 s；恢复错误率 <0.1% |
| 稳定性 Soak | 50 Room × 10 WS，持续 4 小时 | 死锁/崩溃/Invariant violation = 0；稳态后进程内存无持续单调增长，末小时均值不高于首个稳态小时 110% |
| 前端牌桌 | §9.1 设备矩阵的中低档 Android，10 人桌 + Showdown | 无长任务阻塞下注；交互响应 p95 ≤200 ms；动画目标 60 FPS、最低验收 p95 ≥50 FPS |
| 容量余量 | 单实例 130 Room × 10 WS，持续 10 分钟 | 不崩溃、不 OOM、Invariant violation = 0、无跨桌污染；允许延迟超出正常 SLO，但必须记录拐点和资源瓶颈 |

容量测试必须使用真实投影与序列化路径，不能用空 handler 替代；100/1,000 是必须满足全部 SLO 的发布容量，130/1,300 是 30% 安全余量而非对外承诺容量。P1 AI 压测将 AI 延迟与游戏服务容量分别测量，避免第三方波动掩盖本地瓶颈。

### 10.2 监控验收【工程基线】

- 每个 P0/P1 指标均需验证“代码产生 → 采集 → Dashboard → 告警”完整链路，不能只验证埋点函数被调用。
- 发布前通过故障注入触发一次 Game Error/Invariant Violation、重连率、Action Rejection Rate 告警；校验告警包含版本、环境、room/tournament 关联标识且不含私密牌或 Token。
- 告警总负责人为项目总负责人；P0 告警发送至其启用推送/电话提醒的即时渠道并以邮件兜底，P1 告警发送至同一即时渠道。具体服务账号可随部署环境选择，但未验证送达前不得宣称“监控已完成”。

| 级别 | 告警条件 | 响应要求 |
| --- | --- | --- |
| P0 | 任一 Invariant violation、隐藏信息泄露信号、比赛死锁、Critical Engine Error、持久化 hard watermark/OOM 风险 | 立即告警；停止受影响候选发布，冻结/隔离该桌并保存脱敏诊断 |
| P1 | 业务 5xx >1% 持续 5 分钟且请求数 ≥20；重连失败率 >1% 持续 10 分钟且尝试数 ≥20；意外 WS 断连率 >5% 持续 10 分钟 | 10 分钟内通知；调查版本、网络和资源趋势 |
| P1 | 非预期 Action Rejection Rate >2% 持续 10 分钟且 Action ≥50；Persistence DEGRADED 持续 5 分钟；P1 AI Fallback Rate >5% 持续 10 分钟且请求 ≥20 | 10 分钟内通知；按原因码拆分，用户输入错误不得掩盖服务端回归 |

指标保留 90 天，应用日志保留 30 天，安全/权限审计记录与 Release 证据保留 180 天；任何包含 Token、完整 Deck、未公开底牌或 AI 隐藏 Reasoning 的数据禁止进入上述存储。总负责人每季度及每个 Release Candidate 前复核一次脱敏、告警送达和权限。

## 11. CI 分层与门禁

唯一权威：本表（《区块6-10 v0.2》§9.20；门槛对齐《总规划》§9.2）。

| 阶段 | 执行内容 | 门禁 |
| --- | --- | --- |
| PR 必跑（Merge Queue 前） | Lint、Typecheck、Unit、Poker Rules、Protocol/投影安全、关键 Integration、Build、Simulator Smoke | 全部通过且达到 §2.2 覆盖率；任何失败或 Flaky 禁止进入合并队列 |
| Merge Queue | 完整 Integration、Multiplayer/WS、关键 E2E | 基于最终合并提交全部通过方可落主分支；旧提交的成功结果不可复用 |
| 主分支/Nightly | 全量 E2E、≥10,000 场 Simulation、Reconnect Stress、依赖/Schema 检查；P1 启用后每周加完整 AI Scenario | 失败自动创建/更新缺陷并阻断该提交成为 Release Candidate；不得只“记录趋势” |
| Release Candidate | 固定候选提交的完整 E2E、§5 RC Simulation、§10 Load/Soak、真实设备、安全与监控演练、人工动画验收；P1 加 AI Cost/Fallback | §12 全部门槛与证据齐全；任一代码/配置变更使受影响证据失效并重跑 |

CI 平台采用 GitHub Actions，工作流放置于 `.github/workflows/`【工程基线】；Nightly/Release 的大规模任务可调用独立 Runner，但结果必须回传为同一提交的 Check。依赖缓存只加速安装，不缓存测试成功结论。

已落地事实（2026-08-21，TEX-12）：`.github/workflows/ci.yml` 的 `quality` job 在 lint/typecheck/build 后按层独立调用 `pnpm test:unit`、`test:rules`、`test:integration`、`test:ws` 与 Simulator Smoke；独立 `e2e` job 安装 Chromium 后运行 `pnpm test:e2e`（当前为基础设施冒烟与 §9 门禁自测），失败时经 `actions/upload-artifact` 上传失败产物；E2E 禁用重试（§2.1），未处理 console error / pageerror / 5xx 由 observability fixture 强制失败（白名单除外）。完整 Integration、Multiplayer/WS、全量 E2E 与 Nightly/RC 阶段按上表随对应业务任务启用。

Simulator CI 落地事实（2026-08-24，TEX-16）：PR Smoke 由 `ci.yml` 以 `pnpm test:sim -- --tier smoke --sha "$GITHUB_SHA"` 真实运行（已知失败 seed 回归集 + 提交 SHA 派生 ≥200 场，约 20s）；Nightly 经 `.github/workflows/simulator.yml` 的 `schedule`（每日 02:00 北京时间）或 `workflow_dispatch` 运行——按**每种 Blind Mode 各**派生 ≥10,000 个强制该模式的 seed（合计 ≥30,000，满足 §5 逐模式下限），并上传绑定提交 SHA 的 JSON Artifact（tier、gitSha、seed 范围、覆盖统计与失败现场；RC 将同类报告绑定候选提交保存，普通运行报告不提交仓库）；RC 需 seed 台账（`--ledger`），在本地/受控环境手动执行，不进入普通 PR CI。Nightly/RC 是合并后/候选发布阶段门禁，不阻塞 PR 创建。

场景加权裁决（2026-08-24）：初始加权为明确冻结值（见 `tests/simulator/README.md`「场景加权策略」）；在至少连续 3 次 Nightly 数据后，依据实际覆盖缺口调整权重，并在该文档记录原因与前后数据。引擎缺陷不在 Simulator 任务分支修复：模拟器确认的 P0/P1 规则缺陷创建独立 Linear 缺陷任务并阻塞验收，P2/P3 记录为后续任务。

## 12. 缺陷分级与发布门槛

### 12.1 缺陷分级（《总规划》§9.2）

| 级别 | 示例 | 处理 |
| --- | --- | --- |
| P0 | 错误发牌、重复牌、Pot/赢家错误、私密底牌泄露、比赛死锁 | 禁止上线 |
| P1 | 重连失败、计时/下注额错误、Action 冲突、主流程不可用 | 阻断发布 |
| P2 | 非核心 UI 偏移、轻微掉帧 | 排期修复 |

《区块6-10 v0.2》§9.21 另有 P1 阶段示例"AI 经常卡住"，同按 P1 阻断发布处理（§16 冲突 1）。

### 12.2 P0 发布硬门槛（《总规划》§9.2）

- 全部核心规则测试通过（§3.1）；
- 满足 §5 Release Candidate 规模，且无死锁、不变量破坏或未解释的覆盖空洞；
- 至少两台真实设备能通过邀请码完成完整比赛；
- 刷新、断网、网络切换和移动端后台恢复可用；
- 客户端不能读取隐藏信息（§7 字段级断言）；
- 手机常规下注无需键盘；
- 核心发牌/翻牌/Showdown 动画在桌面和手机上可接受；
- §2.2 覆盖率、§10 性能/Soak 与监控演练、§11 Release Candidate 门禁全部通过；
- 候选提交不存在未处置的 P0/P1 缺陷，且发布证据均明确关联同一不可变提交 SHA 与部署配置版本。

### 12.3 P1 附加门槛（《区块6-10 v0.2》§9.22 的 AI 相关项）

- DeepSeek 故障（超时/500/非法输出）不影响比赛继续（Fallback 生效，§8）。
- §8.1 的 80 场景/2,400 次质量门禁全部通过，且报告绑定当前模型、Prompt、参数和候选提交。
- §2.3 的 DeepSeek Sandbox Contract Test 通过，Token/成本未突破硬预算且 Secret/日志检查无泄露。

### 12.4 发布证据包【工程基线】

每个 Release Candidate 生成一份可追溯清单：提交 SHA、依赖锁文件摘要、部署配置版本、各 CI Check 链接、Simulation Seed 范围与分布报告、E2E/Load/Soak 报告、设备矩阵结果、安全/监控演练记录、已知 P2 与批准人。证据不齐等同门禁未通过；不得以“上次版本通过”替代当前候选结果。

## 13. 明确不测的部分与原因

| 不测 | 原因 | 依据 |
| --- | --- | --- |
| 服务进程崩溃后的进行中 Hand 无损恢复 | 非 P0 硬要求；崩溃恢复测试限"恢复到最近手末 Snapshot" | 《总规划》§7.2；[03](./03-data-model.md) §11 |
| AI 决策的唯一最优解 | 测试目的是避免明显荒谬行为，不要求唯一动作 | 《区块6-10 v0.2》§9.15 |
| 外部自由观战 | P0 不支持 | [02](./02-protocol-spec.md) §15 |
| Replay、账号、真钱/支付、MTT | 不在 P0/P1 路线图 | 《总规划》附录 A |
| 分布式/多区域一致性（Redis/Kafka/K8s） | 单实例模块化单体 | [04](./04-game-server-architecture.md) §18 |

## 14. Known Limitations（当前覆盖空白）

- 测试基础设施（TEX-12，2026-08-21）已落地：Vitest 分层入口、fast-check、Playwright + axe-core、Seed/Fake Clock/Fixture Builder/数据库隔离工具与 E2E 失败产物；业务测试（规则、联机、投影、性能）随对应任务回填。
- 持久化 Integration（TEX-18，2026-08-23）已落地：`apps/game-server/tests/integration/` 覆盖迁移（空库一次成功/幂等）、控制面原子写入、手末 Commit Bundle（对齐/回滚/幂等/冲突）、约束（FK/CHECK/唯一）与最小权限（anon/authenticated 拒绝），运行于真实 PostgreSQL 隔离 schema；CI 未配置测试库时该层仍受控跳过。
- §3.1/§3.2 的 Tournament 运行时测试项已随 TEX-20 落地（unit 层，`apps/game-server/src/tournaments/**/*.test.ts` 与 `projection/state-projector.test.ts`）：单桌串行化、`receivedAt` 截止裁决（截止前合法 Action 胜过 Timer / 迟到 `ACTION_TIMEOUT` / `STALE_GAME_STATE`）、Time Bank（扣减/机会一次性/UNLIMITED 禁用）、断线宽限与无真人关房、重复/非法/过期命令不污染状态、事件 sequence 与 Commit Bundle 对齐、time 模式升盲、Room↔Tournament 开局/终局闭环；全部使用 Fake Clock + 注入随机源，不依赖真实 DB 或 sleep。仍依赖真实 PostgreSQL 的"持久化 Writer 队列/watermark"与"崩溃恢复"测试项属 TEX-22，未随 TEX-20 落地。
- Artillery Load/Soak（`test:load`）仍未实现；Headless Simulator 长跑已按 TEX-16 落地（`tests/simulator/`，§5），大规模 Nightly/RC 运行记录随发布流程回填。
- Simulator 失败 seed 的自动缩减未实现（§5 实施状态说明）：当前失败 seed 由人工确认后加入 `tests/simulator/known-seeds.ts`；首次大规模运行尚未执行，回归集为空。
- 覆盖率工具（`@vitest/coverage-v8`）尚未安装；§2.2 覆盖率门槛在首个业务包落地任务中启用并回填。
- §2.2 覆盖率和 §10.1 性能数字是初始门槛；实现后仍需基于真实基准验证其可达性，调整必须留有评审记录且不得掩盖回归。
- 动画/音效/下注手感依赖真实设备人工验收，无法全自动（《区块6-10 v0.2》§9.1）。
- P0 无 BOT：AI 测试全部挂 P1（《总规划》§6）。
- 当前没有部署环境，监控端到端告警、第三方 Sandbox Contract Test 和真实移动网络只能在环境建立后落地。

## 15. TBD 裁决记录（当前无待确认项）

以下裁决由总负责人于 2026-08-21 确认；其中量化细节由工程基线补全：

| # | 已裁决事项 | 规范落点 | 责任人 |
| --- | --- | --- | --- |
| 1 | 实机为中低档 Android + iPhone 15；桌面包含 Edge，并自动覆盖 Chromium/Firefox/WebKit；“当前版本”在 RC 时冻结 | §9.1 | 总负责人 |
| 2 | AI Scenario Set 固定 80 个、每场景 30 次；Schema/Fallback、禁止动作、无逻辑 All-in 与 AKs 哨兵阈值按量化门禁执行 | §8.1 | 工程维护，总负责人确认标签/变更 |
| 3 | 总负责人承担告警、值班、脱敏和权限审计总责；阈值、送达方式与 90/30/180 天保留期已锁定 | §10.2 | 总负责人 |
| 4 | P0 发布容量固定 100 Room/1,000 WS，并验证 130 Room/1,300 WS 的 30% 安全余量 | §10.1 | 工程执行，变更须总负责人批准 |
| 5 | Supabase/DeepSeek 使用隔离 Sandbox；账号、频率、额度、预算、Secret 范围和 90 天轮换规则已锁定 | §2.3 | 总负责人管理凭证与预算，工程维护测试 |

此前已关闭的其他 TBD：测试框架与目录（§2）、E2E 框架（§2/§9）、CI 平台（§11）、Simulator 分层规模（§5）、覆盖率（§2.2）、多客户端测试驱动方式（§2/§6）和负载工具/性能基线（§10.1）。实现验证若推翻任何选择，必须重新打开明确编号的 TBD、记录证据并由总负责人批准，不得直接修改门禁以迁就失败实现。

## 16. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据；《区块6-10 v0.2》§9 提供《总规划》未重述的分层细节。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | P1 缺陷示例 | 《区块6-10 v0.2》§9.21："AI 经常卡住" | 《总规划》§9.2："计时/下注额错误、Action 冲突、主流程不可用"（P1 口径） | 以《总规划》为准；docx 的 AI 项保留为 P1 阶段缺陷示例（§12.1） |
| 2 | 发布门槛范围 | 《区块6-10 v0.2》§9.22 为含 AI 的 MVP 硬门槛 | 《总规划》§9.2 为 P0 发布门槛（不含 DeepSeek 项） | 分两档：P0 门槛按《总规划》§9.2；AI 项并入 P1 附加门槛（§12.3） |
| 3 | Invariant 断言中的筹码守恒公式 | 《区块6-10 v0.2》§9.8 隐含 §6.15 旧式"玩家筹码 + 未结算 Pot = 比赛总筹码" | 《总规划》§4.1："在场筹码 + 未结算 Pot + `forfeitedChips` = 初始总筹码" | 以《总规划》为准（同 01 §21 冲突 2，本文只记测试侧影响） |

本版为关闭“有范围、无执行口径”的空白而新增以下工程决策；它们不声称来自上游规划：

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 测试工具 | Vitest + fast-check + Playwright/axe-core + Artillery + Node Simulator CLI | 与 TypeScript/pnpm Monorepo 一致，分别覆盖确定性、性质测试、真实浏览器/可访问性、WS 负载与长跑 |
| CI | GitHub Actions + 受保护合并队列 | 让结果绑定最终合并提交，避免分支通过但合并后失败 |
| 质量量化 | §2.2 覆盖率、§5 Simulation 分层、§10.1 性能基线 | 将“充分测试/性能可接受”变为可复核门禁 |
| 发布追溯 | §12.4 候选版本证据包 | 确保自动化、人工与部署配置均绑定同一候选提交 |

《总规划》v1.0 新增、docx 未覆盖的测试相关决策（本文已吸收）：不限时模式测试项（§3.1）；超时竞争裁决四步语义可重放、可测试（§3.2）；无真人关房 `ABANDONED_NO_HUMAN`（§4.2，对应 §3.2 测试项）；P0 开局 ≥2 真人且房主不能绕过 Ready（§2.1，对应 §3.2 Ready/开局锁定测试）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。
