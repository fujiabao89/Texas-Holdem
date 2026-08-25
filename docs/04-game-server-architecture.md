# 04 · Game Server 工程设计（`apps/game-server`）

> 状态：设计基线（未实现）
> 规划核对：2026-08-21（Engineering Documentation Agent）——项目尚无代码，本文全文为**设计意图**，未与任何实现核对
> 权威范围：本文是 Game Server（`apps/game-server`，Node.js + Fastify + `@fastify/websocket`，《总规划》§6）运行时工程设计的唯一权威来源——模块划分、Room/Lobby 与 Tournament 两级串行边界、Tournament 串行执行器（`receivedAt`/`actionId`/`expectedSequence` 与超时竞争裁决）、Scheduler 与 Timer（行动超时 / Time Bank / 断线宽限 / 定时升盲）、连接管理（`connection → player → seat` 与多设备接管）、HTTP/WS 入口编排、状态投影执行、持久化编排与崩溃恢复、无真人关房、P1 AI 接入点。范围之外的事实见 [工程文档总索引](./README.md)：规则语义属 [01](./01-engine-spec.md)，wire 可见契约属 [02](./02-protocol-spec.md)，持久化模型属 [03](./03-data-model.md)，AI 推理属 P1 `server/ai`，UI 属 `apps/web`。wire 可见行为（消息名、信封、错误码）以 [02](./02-protocol-spec.md) 为准，本文只规定 server 侧执行行为。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§2.1/§2.3/§3/§4/§5/§6/§7.2/§8/§9.1）；《德州扑克项目规划_区块6-10_v0.2.docx》§6.3/§7.2/§7.6/§7.13–7.20/§8.1/§8.3/§8.7/§8.8/§8.11/§8.13/§10.8/§10.11（仅在《总规划》未覆盖处补充）；《德州扑克项目规划_区块1-5_v0.1.docx》§4（房间与离开的产品语义）
> 对应代码：`apps/game-server/`（**待创建**；模块布局与命名以 §4.1 为准）
> 上级索引：[工程文档总索引](./README.md)

> **【设计意图 · 未实现】** 除下方「实现核对 · TEX-19」标注的章节（§4/§5/§10）已落地外，本文其余章节（§6–§9、§11–§15 及依赖它们的 §16 校验项）仍为设计意图，尚无代码可核对。§20 所列原待决项均已裁决；实现落地后逐模块对照实现回填真实行为，把"设计意图"改为"现状"，并删除本标记。

> **【实现核对 · TEX-19，2026-08-24】** §4 模块布局、§5 Room/Lobby 生命周期（状态机、邀请码、开局条件、配置、Host 转移、Lobby 成员、§5.7 串行执行）、§10 HTTP 入口（校验链、幂等、限流、昵称、日志）已由 `apps/game-server/src/{http,rooms}/**` 落地并经 unit/integration 测试核对。`RoomRepository` 在既有事务边界上扩展了 Lobby 写方法（加入/状态/配置/Host/离开/开局），不新建表或迁移；`TournamentStarter` port 已定义，默认实现仅落库，Hand/Tournament 运行时属 TEX-20。§6–§9、§11–§15（Tournament 运行时、连接管理、Scheduler、投影执行、持久化编排、恢复）仍为设计意图。

> **【实现核对 · TEX-20，2026-08-24】** §6 Tournament 运行时、§7 单桌串行执行器（真队列 + 截止点 look-ahead、receivedAt 仲裁、幂等/sequence、Engine 驱动循环）、§8 Scheduler 与 Timer（行动超时/Time Bank/断线宽限/定时升盲）、§11 状态投影执行、§12 手末 Commit Bundle 构造入口已由 `apps/game-server/src/{tournaments,scheduler,projection}/**` 落地并经 unit 测试核对（见各目录 README）。实现边界与未覆盖项：
> - **Room 集成**：`createRuntimeTournamentStarter` 在 Room 队列确认开局后创建 Tournament 运行时并注册（§5.7）；终局/无真人经 `TournamentOutputSink.submitRoomCommand` 单向投递 `TOURNAMENT_FINISHED`/`CLOSE_ROOM`（§5.7 单投递规则）。
> - **计时**：行动超时/Time Bank/断线宽限/定时升盲均以可注入 Clock/`TimerScheduler` 为权威（§8.4）；生产注入单调且近似 epoch 的时钟（`createMonotonicEpochClock`，§7.2 单调裁决）；Timer 携带 generation，执行前复核、过期 no-op（§8.2）。Time Bank 机会标记仅在手/街/座位构成的决策点变化时复位（§8.4「每个行动机会最多一次」）。
> - **投影**：`PlayerView`/wire `GameEvent`/`PlayerViewPatch` 由 `projection/state-projector.ts` 纯函数生成（字段级隔离，红线 2）；Patch 为**逐事件**全字段新视图——Engine 新增 `getEventStates()`（与事件流平行的每事件后状态快照，§14 逐事件投影），使 `PLAYER_CHECKED` 的 patch 不携带后续 `FLOP_DEALT` 才产生的 board/phase，满足 02 §6.3「得到该事件后的权威视图」。
> - **持久化入口**：执行器在整手结算后构造 `HandCommitBundle` 交 `TournamentOutputSink.enqueueCommitBundles`；**DB Writer（异步队列/退避/watermark）属 TEX-22**，`main.ts` 暂为空实现。
> - **手间事件边界**：两手之间的 `PLAYER_WITHDRAWN` 作为下一手 bundle 的前导事件落入同一原子提交（其 sequence 仍在手 N 之后、手 N+1 之前，快照边界「Withdraw 均已应用、下一手 HAND_STARTED 尚未发生」成立）；TEX-22 Writer 需据此验证。
> - **连接管理（TEX-21）**：`GET /api/v1/ws` 首帧只接受 v1 `AUTHENTICATE`，5 秒认证时限；成功先发 `RECONNECT_RESULT`（含 Room 与按接收者投影的 Game Snapshot），再接收命令。Runtime 输出经内部 Event Bus 进入这条唯一 Gateway；`REQUEST_SNAPSHOT` 从当前内存 Runtime 重新投影。连接 epoch 在 Tournament 执行器执行点校验，旧 Socket 已排队的 Action/Time Bank 也会被拒绝。每 15 秒 Ping，45 秒无 Pong/有效帧终止；时钟可注入测试。
> - **未覆盖**：§9.5 的事件积压/Fast Forward 阈值与 Close 1013、§13.1 优雅关停完整流程（仅实现 `SHUTDOWN` 队列命令）、§13 崩溃恢复读取路径（TEX-22）、P1 AI 接入（§14）。
> - **Engine 序列映射**：Engine 内部 sequence 为 0 基；wire/持久化 sequence 由执行器分配为 1 基跨手全局递增（`engineSeq + 1`，02 §7.1），与 03 §7.3 水位线咬合。

## 1. Purpose

Game Server 是唯一真实状态的宿主（《总规划》§6："规则属于 Engine；唯一真实状态属于 Game Server；客户端只能展示和提交请求"）。它把三份已确认契约组装成可部署的实时服务：

- [01](./01-engine-spec.md) 的纯规则引擎（无 UI/网络/DB），由 server 作为唯一调用方驱动；
- [02](./02-protocol-spec.md) 的 wire 契约（通道分工、信封、幂等、错误码、投影契约），由 server 实现执行侧；
- [03](./03-data-model.md) 的持久化模型，由 server 作为唯一写者编排。

它同时是五条架构红线的执行者（《总规划》附录 B）：规则唯一权威（红线 1）、私有信息不出服务端（红线 2）、单桌串行（红线 3）、输入再校验（红线 4）、局部故障只降级该参与者（红线 5）。

## 2. Responsibilities / Non-Responsibilities

### 2.1 负责

| 职责 | 依据 |
| --- | --- |
| HTTP 入口：创建房间、邀请码加入、Lobby 低频设置、退出 | 《总规划》§5.2；[02](./02-protocol-spec.md) §4/§8.1 |
| WS 连接生命周期与 `connection → player → seat` 映射 | 《总规划》§5.2；《区块6-10 v0.2》§7.6 |
| Room 生命周期、开局条件执行、房主转移 | 《总规划》§2.1/§4.2/§5.1 |
| Room/Lobby 串行执行：成员、Ready、配置、房主与开局竞态 | [02](./02-protocol-spec.md) §6.2/§8；本文 §5.7 |
| Tournament 运行时：Hand 驱动、盲注级别推进、淘汰/冠军/终局 | [01](./01-engine-spec.md) §6/§12；《总规划》§2.3 |
| 单桌串行执行器：`receivedAt`/`actionId`/`expectedSequence`、超时竞争裁决 | 《总规划》§3.2 |
| Scheduler 与 Timer：行动超时、Time Bank、断线宽限、定时升盲 | 《总规划》§3.1/§4.1；《区块6-10 v0.2》§7.14 |
| 状态投影执行（`PlayerView`/`BotView`） | 《总规划》§5.3；[02](./02-protocol-spec.md) §9 |
| 持久化编排（唯一写者、写节奏、失败降级） | [03](./03-data-model.md) §7/§9 |
| 无真人关房（`CLOSED`/`ABANDONED_NO_HUMAN`） | 《总规划》§4.2 |
| 结构化日志与限流 | 《区块6-10 v0.2》§8.7/§8.8/§8.11；[02](./02-protocol-spec.md) §11 |
| P1 AI 接入点：BotController 以 `ActionSource=BOT_CONTROLLER` 提交 | 《总规划》§6/§8 |

### 2.2 不负责（及归属）

| 不负责 | 归属 | 依据 |
| --- | --- | --- |
| Action 合法性与规则语义（金额、回合、Raise 权） | [01](./01-engine-spec.md) §5.1/§8 | 《总规划》附录 B 红线 4 |
| wire Schema、信封、错误码定义 | [02](./02-protocol-spec.md) | 《区块6-10 v0.2》§10.8 |
| DB 表结构与敏感数据存放规则 | [03](./03-data-model.md) §5/§6 | 《区块6-10 v0.2》§10.10 |
| AI 推理、Prompt 构造、Fallback 策略 | P1 `server/ai` | 《总规划》§8 |
| 动画播放、UI 状态 | `apps/web`（AnimationQueue） | 《区块6-10 v0.2》§7.10 |
| 客户端倒计时 | 仅展示，server 是唯一计时权威 | 《总规划》§3.2 |

## 3. Dependencies

| 依赖 | 类型 | 用途 | 失效影响 |
| --- | --- | --- | --- |
| `poker-engine` | 运行时调用方 | Action Validation 与纯状态转移（[01](./01-engine-spec.md) §3/§16） | Engine Critical Error → 冻结该 Hand、server 停止该桌执行（[01](./01-engine-spec.md) §16；本文 §15） |
| `packages/protocol` | 类型与 Schema | 入口 Schema Validate、信封、错误码（[02](./02-protocol-spec.md) §2.1/§11） | 校验缺失 → 非法输入进业务层 |
| Supabase Postgres | 基础设施 | 记录层（[03](./03-data-model.md) §3） | 短暂故障不回滚或阻塞当前 Hand；写入降级重试，达到资源硬限后在 Hand 边界受控暂停（§12.2） |
| `@fastify/websocket` | 实现工具 | HTTP/WS 通道 | 服务不可用 |
| 密码学安全随机源 | 服务 | 邀请码生成；注入 Engine 供洗牌与首手 Dealer（[01](./01-engine-spec.md) §3/§15） | — |
| P1：`server/ai`、`poker-math` | 被依赖 | AI 座位驱动 | AI 失败降级该参与者，牌局继续（红线 5） |

反向约束：不依赖 `apps/web`；客户端永不直连 DB（[03](./03-data-model.md) §9）；server 自身也不绕过 Engine 修改规则状态（红线 1）。

## 4. 总体架构与模块划分

```text
HTTP / Lobby WS ──▶ 入口层 ──▶ Room 串行执行器 ──▶ Room Manager
                                      │（唯一开局提交）
                                      ▼
                              Tournament Manager
                                      │
扑克 WS Action ──▶ Connection Manager ──▶ Tournament 串行执行器 ◀── Scheduler
 （connection→player→seat→epoch）             │                    （Timer 任务）
                                              ▼
                                         poker-engine
                                     （校验 + 纯状态转移）
                                              │
                                 GameState' + Events[sequence]
                                              │
                           ┌──────────────────┼──────────────────┐
                           ▼                  ▼                  ▼
                   State Projector     Connection Manager   Persistence Writer
                  （逐接收者投影）      （逐连接推送/快照）      ──▶ Postgres（03）
```

| 模块 | 职责 | 契约归属 |
| --- | --- | --- |
| HTTP 层 | 创建/加入/设置/退出；Schema Validate；限流 | [02](./02-protocol-spec.md) §4/§8；本文 §10 |
| Connection Manager | WS 生命周期、连接映射、接管、断线/重连 | [02](./02-protocol-spec.md) §4/§10；本文 §9 |
| Room 串行执行器 | 每个 Room 的成员、Ready、配置、Host、状态迁移与 Tournament 创建串行提交 | 本文 §5.7 |
| Room Manager | Room 状态机、邀请码、房主、开局条件 | 本文 §5 |
| Tournament Manager | 一场比赛的 Hand 驱动、盲注推进、终局 | 本文 §6；[01](./01-engine-spec.md) §12 |
| 串行执行器 | 一桌一队列；裁决、幂等、Engine 调用、事件分发 | 本文 §7；[02](./02-protocol-spec.md) §7 |
| Scheduler | 行动超时 / Time Bank / 断线宽限 / 定时升盲 | 本文 §8 |
| State Projector | `PlayerView`/`BotView` 生成 | [02](./02-protocol-spec.md) §9；本文 §11 |
| Persistence Writer | 唯一写者、写节奏、失败降级 | [03](./03-data-model.md)；本文 §12 |
| AI Seat Driver（P1） | Bot 座位驱动、`BOT_CONTROLLER` 源 | 《总规划》§8；本文 §14 |

原则：Room 可见状态只能由对应的 Room 串行执行器提交；Tournament/Engine 状态只能由对应的 Tournament 串行执行器提交。其他模块只能读取不可变快照或投递命令，不能直接 mutate（《总规划》§5.2；红线 1/3）。

### 4.1 模块文件布局与命名

`apps/game-server` 采用以下固定边界；允许在模块内部继续拆文件，但不得把业务状态写入入口层或 Composition Root：

```text
apps/game-server/
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ main.ts                         # 进程入口、信号处理
   ├─ app.ts                          # Fastify 组装与依赖注入
   ├─ config.ts                       # 环境变量解析与启动校验
   ├─ http/
   │  ├─ routes/{health,rooms,tournaments}.ts
   │  └─ middleware/{auth,idempotency,rate-limit}.ts
   ├─ ws/
   │  ├─ websocket-gateway.ts
   │  ├─ connection-manager.ts
   │  └─ command-router.ts
   ├─ rooms/
   │  ├─ room-runtime.ts
   │  ├─ room-executor.ts
   │  ├─ room-manager.ts
   │  └─ room-commands.ts
   ├─ tournaments/
   │  ├─ tournament-runtime.ts
   │  ├─ tournament-executor.ts
   │  ├─ tournament-manager.ts
   │  └─ tournament-commands.ts
   ├─ scheduler/{scheduler,timer-task}.ts
   ├─ projection/state-projector.ts
   ├─ persistence/
   │  ├─ persistence-writer.ts
   │  ├─ commit-bundle.ts
   │  └─ repositories/
   ├─ observability/{logger,metrics}.ts
   └─ ai/                             # P1；P0 不装配
```

- 文件与目录使用 `kebab-case`；类型、类与枚举使用 `PascalCase`；函数/变量使用 `lowerCamelCase`；wire 枚举值继续遵循 [02](./02-protocol-spec.md) 的 `UPPER_SNAKE_CASE`。
- `main.ts`/`app.ts` 只负责装配，不含 Room、Tournament 或扑克规则分支；跨模块依赖通过显式接口注入，禁止从其他模块深层路径读取可变 Runtime。
- 测试与被测文件同目录，命名 `*.test.ts`；跨模块集成测试放在 `apps/game-server/test/integration/`。

## 5. Room 生命周期管理

### 5.1 状态机

`CREATED → LOBBY → IN_GAME → FINISHED → LOBBY`；在 Lobby 或无真人时可转 `CLOSED`（《总规划》§5.1/§4.2）。

| 迁移 | 触发 |
| --- | --- |
| `CREATED → LOBBY` | 创建成功即进入 Lobby（《总规划》§5.1） |
| `LOBBY → IN_GAME` | 开局条件满足（§5.3） |
| `IN_GAME → FINISHED` | 冠军产生（[01](./01-engine-spec.md) §12） |
| `FINISHED → LOBBY` | 保留邀请码与配置，可"再来一局" |
| 任意 → `CLOSED` | Lobby 关闭；或比赛中已无真人（§6.5） |

Room 是邀请和人员容器，Tournament 是 Room 中的一次实际比赛；"再来一局"创建**新 Tournament**，不复用旧牌局状态（《总规划》§5.1）。`IN_GAME` 期间 Room 与一场 Tournament 一一对应（[03](./03-data-model.md) §5.3）。

### 5.2 邀请码

- 固定使用 31 字符字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`，生成 6 位大写邀请码；排除 0/O、1/I/L，只定位房间、不充当身份凭证；邀请链接仅预填邀请码（《总规划》§5.1；[02](./02-protocol-spec.md) §5）。
- 使用密码学安全随机源逐字符 rejection sampling，禁止对随机字节直接取模造成偏差。数据库以“非 CLOSED Room 的邀请码唯一”约束作最终裁决；冲突最多重新生成 10 次，每次生成完整新码。
- 连续 10 次冲突视为服务异常：创建 Room 失败、返回可重试的 503/`INTERNAL_ERROR`、记录 Critical 指标；不得降级为更短邀请码或可预测序列。有效 Room 总量同时受 §10.3 的 130 Room 单实例硬限约束。
- `CLOSED` 后立即失效，不能再加入或"再来一局"（《总规划》§4.2）。

### 5.3 开局条件与锁定

P0 开局条件（《总规划》§2.1，server 逐一校验）：

1. 至少 2 名真人参赛者；
2. 所有真人（包括房主）均处于 Ready；
3. 无未完成的配置变更；
4. Room 仍在 `LOBBY`。

房主不能绕过自己的 Ready 状态强制开始（《总规划》§2.1）。P1 加入 AI 后：至少 2 名总参赛者且至少 1 名真人；AI 默认 Ready（《总规划》§2.1）。

开局动作：在 §5.7 的 Room 队列中锁定参与者、Seat 与核心配置（《总规划》§2.3）；创建 Tournament 运行时并调度其记录持久化（[03](./03-data-model.md) §5.3）；请求 Engine 初始化（首手 Dealer 由服务器随机源选择，[01](./01-engine-spec.md) §11）。开局后房主只是一名普通参赛者（《总规划》§7.1；《区块6-10 v0.2》§7.6）。

### 5.4 配置管理

- 房主仅可在 Lobby 调整比赛结构（人数、初始筹码、盲注、行动时间、Time Bank、Blind Structure）；不能修改核心扑克规则（《总规划》§2.3/§7.1）。
- 配置经服务端最终 Schema Validation 后写入（《区块6-10 v0.2》§10.11）；规则约束权威在 [01](./01-engine-spec.md) §2.1/§12。
- 开局后锁定：不新增真人/AI、不换座、不改核心配置（《总规划》§2.3）。
- Lobby 权限：改配置、踢人仅房主；开局后锁定（《总规划》§7.1）。

### 5.5 房主与转移

- 比赛前房主离开 → 房主权转给最早加入且仍在线的真人（《总规划》§4.2）。
- 比赛中房主断线不影响服务端运行，也没有任何特殊扑克权限（《总规划》§4.2）。
- Lobby 内房主断线时启动 60 秒 Host Grace Timer；60 秒内重连则取消。到期仍处于 `LOBBY` 且原房主仍离线时，Room 队列把房主权转给 `joinedAt` 最早、当前在线的真人，并递增 `roomRevision`。
- 到期时没有在线真人则暂不转移；之后首位真人成功连接时，由 Room 队列在发送最新 `ROOM_SNAPSHOT` 前将其设为房主。原房主在转移后重连只作为普通成员，不自动夺回房主权。主动离开不享受 60 秒宽限，立即按第一条转移。

### 5.6 Lobby 成员

Lobby 成员关系以 game-server 内存为运行期权威，并按 [03](./03-data-model.md) §5.2 持久化身份摘要；每次对客户端可见的 Room 变更提交后递增 `roomRevision`，通过全量 `ROOM_SNAPSHOT` 推送（[02](./02-protocol-spec.md) §6.2/§8.2）。

### 5.7 Room/Lobby 串行执行

- 每个 Room 自创建起拥有一个串行执行器。加入、离开、Ready、配置修改、踢人、房主转移、`LOBBY/IN_GAME/FINISHED/CLOSED` 迁移和创建 Tournament 都必须进入该队列；HTTP 与 WS 入口不得直接修改 Room 状态。
- 命令在入队前做 Schema/身份初检，在取得执行权后基于**最新 Room 状态再次校验**权限、容量、昵称唯一性与 Ready 条件，提交后才递增 `roomRevision`。因此两个并发加入、配置修改或开局请求不会发生检查后写入竞态。
- 开局是一次内存原子提交：确认 `status=LOBBY` 且不存在活跃 Tournament → 冻结参与者/Seat/配置 → 创建唯一的新 `tournamentId` 与 Tournament 串行执行器 → Room 转 `IN_GAME` → 递增 `roomRevision`。并发开局请求中只有第一个可以提交，其余按最新状态拒绝；不得创建第二场活跃 Tournament。
- 跨 Room/Tournament 的生命周期信号不同时持有两把执行锁：Tournament 在释放自身执行权后，向 Room 队列投递带 `expectedTournamentId` 的 `TOURNAMENT_FINISHED`/`ABANDONED_NO_HUMAN` 命令；Room 执行器再次核对活跃 Tournament 后迁移。该单向投递规则避免双队列死锁与旧比赛覆盖新比赛。
- `CLOSED` 后 Room 队列拒绝所有业务命令，只允许完成持久化与 §13.2 的资源回收。

## 6. Tournament 运行时

### 6.1 一场比赛的生命周期

创建（开局）→ `IN_GAME` → `FINISHED` 或 `ABANDONED_NO_HUMAN`（[03](./03-data-model.md) §5.3）。每桌 Tournament Runtime 封装 Engine 状态、sequence 与 Timer generation；Tournament 串行执行器是该 Runtime 的唯一提交者，Tournament Manager 只负责把 Hand/终局生命周期意图转换为队列命令（§7）。

### 6.2 Hand 驱动循环

每手按 [01](./01-engine-spec.md) §6 状态机推进：发牌 → 逐 Street 等待 Action/超时 → 结算 → 淘汰判定。server 侧职责：

- 把 Action（真人/AI/Timer）交给执行器（§7），Engine 产出 Events 后由执行器分配 `sequence` 并分发；
- "提前结算 2"（所有剩余玩家已 All-in）：Engine 立即完成，server **不等待**客户端；前端按动画队列逐步展示（[01](./01-engine-spec.md) §6）；
- 每手结束触发 Snapshot 落盘（§12；《总规划》§7.2）。

### 6.3 盲注级别推进

- 三种模式：固定 / 按时间 / 按手数（[01](./01-engine-spec.md) §12）。
- 按手数：手末结算后推进；按时间：Scheduler 定时（§8.1）。
- **只在两手之间生效**：定时器到期后仅在当前 Hand 完整结束后应用，绝不在一手牌中途改变下注下限或盲注（《总规划》§2.3）。
- 允许盲注下降，每个 Level 独立校验（《总规划》§2.3）。

### 6.4 淘汰、冠军与终局

- 淘汰/冠军判定规则权威在 [01](./01-engine-spec.md) §12；server 在 `HAND_END` 后驱动判定，推送 `PLAYER_ELIMINATED`/`TOURNAMENT_FINISHED`（[01](./01-engine-spec.md) §14）并落库结果（[03](./03-data-model.md) §5.4）。
- `FINISHED → LOBBY`：保留邀请码与配置，可"再来一局"（新 Tournament）（《总规划》§5.1）。

### 6.5 无真人关房（P0 关键策略）

只要房间中已没有真人：

1. **立即停止**后续 AI 决策与计时任务；
2. Room → `CLOSED`，Tournament → `ABANDONED_NO_HUMAN`；
3. 邀请码立即失效；
4. 已完成的 Hand History 与断开原因持久化保存（《总规划》§4.2；[03](./03-data-model.md) §10）。

不把 AI 自动宣告为冠军（《总规划》§4.2）。"已没有真人"的判定：所有真人均已 `WITHDRAWN`（含断线满 10 分钟者，§6.6）。

### 6.6 离开与撤回流程（`EXIT_PENDING → WITHDRAWN`）

触发：用户确认"主动离开比赛"，或断线满 10 分钟（§8.3）。流程（《总规划》§4.1；Engine 侧状态转移权威在 [01](./01-engine-spec.md) §13）：

1. server 标记 `EXIT_PENDING`；
2. 当前 Hand 如能正常结算则先结算；未 All-in 且仍有行动资格者立即按弃权折叠处理，已投入筹码仍留在相应 Pot；
3. 在安全结算点转 `WITHDRAWN`：不再获得发牌、盲注、行动或排名资格；未投入剩余筹码记 `forfeitedChips`。

`WITHDRAWN` 使用 [01](./01-engine-spec.md) §13 已定稿的 Tournament 级 `WithdrawParticipant` 指令：game-server 在同一 Tournament 串行队列中提交，Engine 校验 `EXIT_PENDING` 与安全结算点。它不是玩家下注 Action，不占用 `currentActor`；如当前仍需立即 Fold，先由该指令驱动 Engine 产生对应的状态转移与事件，再在安全结算点完成撤回。

## 7. 单桌串行执行器（核心）

### 7.1 唯一变更通道

- 一张 Tournament 桌的所有状态改动、Timer 和未来 AI Action 均走同一串行队列；服务端是唯一权威状态源（《总规划》§5.2；红线 3）。
- 每桌一个队列，桌间互不阻塞（单实例模块化单体，[02](./02-protocol-spec.md) §15）。
- 本节的队列只拥有 Tournament/Engine 状态；Lobby/Room 状态由 §5.7 的 Room 队列拥有。Tournament 完成后只向 Room 队列投递生命周期命令，不直接改 Room。

### 7.2 接收与超时竞争裁决

本节落实 [02](./02-protocol-spec.md) §7.4 的规范性决定，消除“截止前已接收但尚未取得执行权是否输给 Timer”的歧义：

1. WS 入口完整解析 Action 并通过基础 Schema 后，立即用服务端单调时钟记录不可伪造的 `receivedAt`，同时分配该进程内严格递增的 `ingressOrdinal`；客户端提供的时间戳或同名字段一律不采信。
2. 行动超时任务携带它建立时的 `handId`、actor、`actionDeadline=D` 与 timer generation。对同一截止点，所有 `receivedAt <= D` 的 Action 排在 Timer 前处理，**即使它们仍在队列等待**；“是否已取得执行权”不参与胜负判断。
3. 截止前 Action 仍须在执行时通过 connection epoch、幂等键、`expectedSequence`、身份、Turn 与 Engine 合法性校验。若失败且状态未推进，Timer 轮到时仍可执行 Auto Check/Fold。
4. `receivedAt > D` 的 Action 不执行：若仍指向同一行动机会，返回 `ACTION_TIMEOUT`；若 Timer 或其他动作已经推进状态，返回 `STALE_GAME_STATE` 并下发最新 Snapshot。
5. 同一截止点前收到多个 Action 时按 `ingressOrdinal` 处理；第一个成功提交的 Action 推进状态，其余通常因 sequence 变化被拒绝。

实现上，Timer 使用逻辑截止时间 `D`，不能以 Node.js Timer 回调实际被调度的墙钟时刻作为胜负依据。入口记录与 Timer 入队都在同一进程完成；队列按上述逻辑优先级选择下一任务，从而使边界情况可重放、可测试。

### 7.3 幂等与 sequence

- `requestId` 是所有 WS 变更命令的幂等键（作用域 `roomId + playerId`），`actionId` 是扑克 Action 的额外幂等键（作用域 `tournamentId + playerId`）。先查幂等缓存、再检查 `expectedSequence`；缓存保留至对应 Room/Tournament 从内存卸载。条目不得因 LRU/TTL 提前淘汰，否则旧重试可能被再次执行；容量与极端情况下的受控 Runtime recycle 见 §10.3。
- 相同 `actionId`、相同 Payload 的重试不再次执行，返回 `duplicate: true` 并复用原结果；相同 `actionId` 携带不同 Payload 返回 `IDEMPOTENCY_KEY_REUSE`，状态不变（[02](./02-protocol-spec.md) §7.3）。
- `sequence` 作用域是一个 `tournamentId`，从 `1` 开始跨 Hand 严格递增，新 Tournament 重置；`expectedSequence` 必须与执行前当前 sequence 完全相等，否则拒绝并下发最新 Snapshot（[02](./02-protocol-spec.md) §7.1）。

### 7.4 执行流水线

```text
入队 → 裁决（§7.2）→ 幂等/sequence 校验（§7.3）
     → Engine Action Validation（01 §5.1）→ Engine 纯转移（01 §16）
     → GameState' + Events → 分配 Tournament 全局 sequence（02 §7.1/§14）
     → 投影（§11）→ 逐接收者推送（02 §8.2）→ 持久化写入（§12）
```

- Engine 拒绝 Action → 不产生任何状态变更，返回错误码（[01](./01-engine-spec.md) §5.1；[02](./02-protocol-spec.md) §11）。
- 一次合法转移的 `GameState' + Events + sequence + actionId 最终结果` 在内存中作为一个原子提交；验证完成到提交之间不得 `await` 外部 I/O。投影、网络发送和持久化都消费提交后的不可变结果，失败不能形成“状态已变但 sequence/幂等结果未记”的半提交。
- Engine Critical Error（负筹码、重复牌、非法状态机）→ 冻结当前 Hand、保存完整诊断、阻止进一步污染；server 停止该桌后续执行（[01](./01-engine-spec.md) §16；本文 §15）。
- 执行器是唯一 mutate 者：其他模块只读状态或投递请求（§4 原则）。

### 7.5 ActionSource 统一

玩家扑克动作与自动 Check/Fold 使用 `HUMAN_SOCKET | BOT_CONTROLLER | SYSTEM_TIMER` 走同一 Engine Action 校验路径，Engine 不因来源放宽规则（[01](./01-engine-spec.md) §2.2/§5.1；《总规划》§6）。P0 仅启用 `HUMAN_SOCKET` 与 `SYSTEM_TIMER`；`BOT_CONTROLLER` 为 P1 预留。`USE_TIME_BANK` 是 Tournament 队列中的 Server 控制命令，`WithdrawParticipant` 是 Tournament 级 Engine 指令，二者都不伪装成玩家下注 Action（[02](./02-protocol-spec.md) §8.1；[01](./01-engine-spec.md) §13）。

## 8. Scheduler 与 Timer

### 8.1 Timer 目录

| Timer | 建立/重置 | 到期行为 | 依据 |
| --- | --- | --- | --- |
| 行动超时（`actionDeadline`） | 每次行动权转移时建立 | Check 合法则 Auto Check，否则 Auto Fold | 《总规划》§3.1 |
| Time Bank | 玩家发起 Server 控制命令 `USE_TIME_BANK` | 在 Tournament 队列中校验并延长当前行动固定时段（如 30 秒）或剩余余额中较小者；余额 `timeBankRemainingMs` 由 server 权威维护，不进入 Engine Action 联合类型 | 《总规划》§3.1；[02](./02-protocol-spec.md) §8.1 |
| 断线宽限 | WS 断开时启动；重连成功则取消 | 满 10 分钟 → `EXIT_PENDING`（§6.6） | 《总规划》§4.1 |
| 定时升盲 | 按时间模式 | 到期后仅在当前 Hand 结束后应用（§6.3） | 《总规划》§2.3 |
| AI 决策计时（P1） | Bot 轮到行动 | 超时/失败走本地 Fallback；牌局不停 | 《总规划》§8（细节属 `server/ai`） |

### 8.2 Timer 也是队列任务

- 行动超时产生的 Auto Check/Fold 以 `SYSTEM_TIMER` 源 Action 进入 Tournament 队列，与真人 Action 在 §7.2 的同一裁决点竞争。断线宽限与升盲 Timer 也只投递内部命令，不直接 mutate。
- 每次建立/重置 Timer 都递增对应的 generation，并把 `tournamentId/handId/actor/deadline/generation` 固化进任务。**执行前必须再次校验**这些字段与当前状态；任一不匹配、Hand/Tournament 已结束或 Timer 已取消，任务即作为 stale no-op 丢弃。
- 取消 Timer 只使旧 generation 失效，不依赖底层 `clearTimeout` 一定来得及；即使回调已在事件循环等待，也不能产生副作用。

### 8.3 模式差异

| 设置 | 行动超时任务 | Time Bank | 断线宽限 |
| --- | --- | --- | --- |
| 有限时（`15/20/30/45/60` 秒，默认 30 秒） | 建立 `actionDeadline` | 总额仅允许 `0/30/60/120` 秒，默认 60 秒；`0` 为关闭 | 10 分钟，保留 |
| 不限时 | 不建立；不自动 Check/Fold | **强制禁用**（协议不接受 `USE_TIME_BANK`） | 10 分钟，保留 |

- 断线不会自动消耗 Time Bank（《总规划》§3.1）。
- 有限时下断线玩家轮到行动时按普通超时 Auto Check/Auto Fold；不限时下靠 10 分钟断线宽限，不会无限阻塞牌局（《总规划》§4.1）。
- `actionTime` 除上述五档外只允许显式 `UNLIMITED`；服务端 Schema 和 Engine Config Validation 均拒绝任意自定义秒数。

### 8.4 权威计时

- `actionDeadline` 与 `timeBankRemainingMs` 由 server 更新并出现在 Snapshot；Time Bank 使用成功后另发 `CLOCK_UPDATED`。Clock 的行动者/截止线是公开行动机会，余额按接收者投影为该接收者自己的余额（[02](./02-protocol-spec.md) §8.2）。
- 服务器单调时钟是唯一计时权威；客户端倒计时仅展示（《总规划》§3.2；[02](./02-protocol-spec.md) §14）。
- 单次成功使用 Time Bank 延长 `min(30_000ms, timeBankRemainingMs)`，并立即扣除同额余额；新 Deadline = 旧 Deadline + 延长量，不按命令处理时刻重新起算。
- 每个行动机会最多成功使用一次；仅当前 actor、有限时模式、`receivedAt <= 当前 actionDeadline`、余额大于 0 且本行动尚未使用时可成功。它与行动超时按 §7.2 同样以 `receivedAt` 裁决；重复、逾期或不可用请求不扣余额。

### 8.5 自动动作入历史

超时自动动作（Auto Check/Auto Fold）同样进入结构化 Hand History（《区块6-10 v0.2》§7.16）；事件沿用 [01](./01-engine-spec.md) §14 的 `PLAYER_CHECKED`/`PLAYER_FOLDED`，并标注 `ActionSource=SYSTEM_TIMER`。

## 9. 连接管理

### 9.1 建立与身份

- 生产环境只允许 WSS。连接升级后按 [02](./02-protocol-spec.md) §4.3 在 5 秒内接收首帧 `AUTHENTICATE { roomId, playerToken }`；邀请码只用于 HTTP Join，不进入 WS 认证。服务端以 Token 摘要查出 `playerId`，不信任客户端自报身份。
- 服务端维护 `connection → player → seat` 映射；客户端只能以自身身份提交动作，**不能指定 Seat 操作**（《总规划》§5.2；《区块6-10 v0.2》§7.6）。
- 认证成功前不接受任何业务命令；认证帧与 Token 字段禁止进入访问日志、Tracing Payload 或错误回显。

### 9.2 单活跃连接与多设备接管

- 同一 `playerToken` 同时只允许**一个活跃控制连接**。Gateway 会先保留新 `connectionEpoch` 与活跃映射，再异步提交 `CONNECTED`/Runtime 重连；因此旧 Socket 在这两个提交之间关闭时已不是 current，不得把陈旧 `DISCONNECTED` 排到新连接之后。认证超时或失败会撤销该保留；若被替换 Socket 仍打开则恢复其映射并重新上报 `CONNECTED`，否则保持断线。只有认证完成并发送 Snapshot 屏障后才将旧连接标为 `REPLACED`（[02](./02-protocol-spec.md) §10）。
- 每条 HUMAN_SOCKET 命令在入口携带内部的 `connectionId + connectionEpoch`（不是 wire 字段）；在 Room 与 Tournament 队列真正取得执行权时再次校验。比赛中离开先在 Tournament 队列校验并确认撤回，随后不带 epoch 的 Room 收尾只完成该已确认撤回的成员/Token 清理。接管完成后，所有尚未提交的旧 epoch Ready、离开、Action 与 Time Bank 均拒绝，不得因早已排队而在新设备取得控制权后生效。
- 服务端尽力向旧连接发送 `SESSION_REPLACED`，随后以 WS Close Code `4001` 关闭。即使通知或 Close 帧丢失，epoch 校验仍保证旧连接不能控制 Seat；新连接只在 epoch 提升与 Snapshot 屏障完成后接收成功结果。

### 9.3 断线

- Connection Manager 检测 WS 关闭后，先使该连接失去入口控制资格，再向 Room 队列投递断线命令；Room 队列提交 `ConnectionStatus = DISCONNECTED`、递增 `roomRevision`，随后在不持有 Room 执行权时向 Tournament/Scheduler 投递断线宽限任务。扑克状态不变（`PokerStatus=ACTIVE` 与 `ConnectionStatus=DISCONNECTED` 可共存，《区块6-10 v0.2》§6.3）。
- 断线玩家保留 Seat、筹码和本手已投入筹码（《总规划》§4.1）。
- 启动断线宽限计时器（§8.3）；刷新/切网/手机后台恢复均先视为断线，不是立即离开（《总规划》§4.1）。

### 9.4 重连

走 [02](./02-protocol-spec.md) §6/§10 流程：认证成功的 `RECONNECT_RESULT` 携带 Room 与按接收者投影的 Game Snapshot；`resumed` 记录该 Room 内此前成功认证的历史，在成员离开/被移出或 Room 关闭前保留。其后 Room 变更只推 `ROOM_SNAPSHOT`，Game Snapshot 只由重连或 `REQUEST_SNAPSHOT` 重同步产生，避免用 Lobby 变化重置牌局投影。后续带 `sequence` 事件；断线期间旧动画不重放；漏序/积压/过期直接重取 Snapshot（《总规划》§5.2/§7.2）。运行期重连从内存投影，不读 DB（[03](./03-data-model.md) §4.3）。

### 9.5 事件积压与 Fast Forward

慢动画/慢设备不能阻塞服务端。对每条连接独立统计尚未交给 socket 的 `GAME_EVENT` 队列与 `ws.bufferedAmount`；满足任一条件即触发 Fast Forward（《总规划》§7.2；《区块6-10 v0.2》§8.13）：

- 待发送 `GAME_EVENT >= 64`；
- 最旧待发送事件等待 `>= 5_000ms`；
- 应用队列估算字节数 + `ws.bufferedAmount >= 256KiB`。

触发后丢弃该连接尚未发送的旧 Game Event，发送 `RESYNC_REQUIRED`，并按 [02](./02-protocol-spec.md) §6.4 Snapshot 屏障生成最新 `GAME_SNAPSHOT`；其他连接和牌桌执行不受影响。服务端不推断客户端动画是否播放完，客户端自身动画积压时也可主动 `REQUEST_SNAPSHOT`。

若总待发送量达到 `1MiB`，或 30 秒内始终无法回落到 `256KiB` 以下，则以 WS Close Code `1013` 关闭该慢连接，让客户端退避后重连；不得继续无限缓存。

### 9.6 心跳

服务端每 15 秒发送 WS Ping；连续 45 秒未收到 Pong 或任何有效入站帧则终止连接并进入断线流程（[02](./02-protocol-spec.md) §4.3）。

## 10. HTTP 入口与输入校验

### 10.1 通道分工

HTTP：创建房间、邀请码加入、初始配置、退出等低频操作；WS：Lobby 更新、Ready、牌局 Event、Action 与重连（[02](./02-protocol-spec.md) §4）。端点清单权威 [02](./02-protocol-spec.md) §8.1。

### 10.2 校验链（红线 4 的执行）

1. 所有外部输入先 Schema Validate 再进入业务层（[02](./02-protocol-spec.md) §2.1；《区块6-10 v0.2》§10.8）；
2. 比赛配置再做服务端最终 Schema Validation（《区块6-10 v0.2》§10.11；约束权威 [01](./01-engine-spec.md) §2.1）；
3. 身份/权限再校验：改配置、踢人仅房主且仅 Lobby（《总规划》§7.1；[02](./02-protocol-spec.md) §5）；
4. Action 由 Engine 再次校验身份、回合、金额与合法性（[01](./01-engine-spec.md) §5.1）。

所有会改变状态的 HTTP `POST/PATCH` 必须携带 `Idempotency-Key`。game-server 以“身份 + endpoint + key”保存 Payload 摘要与最终 HTTP 结果：相同 Payload 重试返回原结果，不同 Payload 复用 Key 返回 `IDEMPOTENCY_KEY_REUSE`；业务命令仍必须进入 Room/Tournament 队列做执行时复核（[02](./02-protocol-spec.md) §4.2）。

### 10.3 限流

默认限流使用进程内 Token Bucket；参数可由环境变量调整，但启动时必须校验 `soft < hard`。生产容量不得低于 [06](./06-testing-strategy.md) §10.1 的 100 Room/1,000 WS 发布基线，除非总负责人批准并记录例外；任何上调都需先压测。多条件同时适用时取最严格者：

| 入口 | 作用域 | 默认额度 |
| --- | --- | --- |
| 创建 Room | source IP | 5 次/分钟（burst 5）且 30 次/小时 |
| 邀请码 Join | source IP | 20 次/分钟（burst 10） |
| 邀请码 Join | inviteCode | 10 次/分钟，防集中枚举/撞库 |
| WS Upgrade/Authenticate | source IP | 30 次/分钟；同 IP 最多 20 条并发连接 |
| 受保护 HTTP 变更 | playerId | 60 次/分钟（burst 20） |
| 全部 WS 命令 | connection | 20 次/秒（burst 40） |
| `SUBMIT_ACTION` + `USE_TIME_BANK` | playerId | 5 次/秒（burst 10） |

超额返回 `RATE_LIMITED` 与 `retryAfterMs`；连续 60 秒内 5 个畸形/未知 WS 帧后发送 `INVALID_MESSAGE` 并以 `4000 PROTOCOL_ERROR` 关闭。认证失败以 `4003 AUTH_FAILED` 关闭并计入 IP Bucket。

| 资源 | soft/default | hard/default | 达到 hard 的行为 |
| --- | --- | --- | --- |
| HTTP Request Body | — | 64KiB | HTTP 413，业务层不解析 |
| 入站 WS Frame | — | 16KiB | `INVALID_MESSAGE` + Close 4000 |
| 每连接 in-flight 命令 | 24 | 32 | `RATE_LIMITED`，不再入业务队列 |
| 单个 Room/Tournament 执行队列 | 192 tasks | 224 个外部槽位 + 32 个系统预留槽位（256 total） | 外部槽位满即拒绝新外部命令；Timer/关闭任务只使用系统预留槽位 |
| 活跃 WS 连接 | 1,000 | 1,300 | Upgrade 返回 503 |
| 活跃 Room | 100 | 130 | 停止创建 Room，已有 Room 不受影响 |
| 同时 `IN_GAME` Tournament | 100 | 130 | 拒绝新开局，Lobby 保留 |
| 单 Room/Tournament 幂等账本 | 50,000 entries 或 32MiB | 100,000 entries 或 64MiB | 当前 Hand 结束并持久化后执行受控 Runtime recycle；期间返回 `GAME_UNAVAILABLE` |
| 持久化待提交队列 | 500 Bundles、128MiB 或 oldest 60s | 2,000 Bundles、512MiB 或 oldest 10min | 按 §12.2 在 Hand 边界暂停 |

幂等账本达到 soft watermark 时立即告警；达到 hard 后不得淘汰旧键。服务端停止新 Hand，完成并持久化当前 Hand，向该 Room 连接发送可重试的 `GAME_UNAVAILABLE` 并以 Close 1012 要求重连，随后卸载并从最新完整 Snapshot 重建 Runtime；重建构成新的内存驻留期。若无法形成完整检查点则保持冻结并人工处置。

生产环境 HTTP CORS 与 WS `Origin` 使用显式 Allowlist，不使用通配来源。上述上限是 P0 单实例默认值：发布前必须在目标机器通过 100 Room/1,000 WS 的完整 SLO，并验证 130 Room/1,300 WS 不崩溃、不 OOM、无跨桌污染；未通过不得发布或绕过保护（[06](./06-testing-strategy.md) §10.1）。

所有 soft watermark 首次命中和持续命中每 60 秒产生一次聚合告警；hard limit 才执行表中的拒绝/暂停行为。部署在反向代理后时，只有来自显式可信代理 CIDR 的 `X-Forwarded-For` 才可作为 source IP，其他请求一律使用 socket peer address，防止伪造 IP 绕过限流。

### 10.4 昵称

2–16 字符、同房间不可重复、服务端校验与输出转义（[02](./02-protocol-spec.md) §5/§13）。

### 10.5 日志

结构化日志至少含 `roomId`、`tournamentId`、`handId`、`playerId`、`eventSequence`、`action`、`errorCode`；**禁止**记录 API Key、`playerToken` 等敏感凭证（[02](./02-protocol-spec.md) §11；《区块6-10 v0.2》§8.11）。

## 11. 状态投影执行

契约权威在 [02](./02-protocol-spec.md) §9；本文规定 server 侧执行要求：

- 内部 `GameState` **绝不**直接发送浏览器；按接收者生成 `PlayerView`（《总规划》§5.3）。
- 逐接收者投影：自己的底牌仅本人；其他玩家未公开底牌、Deck 顺序、Burn 牌面、AI 私有 Reasoning/Prompt 永不进入未授权 Payload（[02](./02-protocol-spec.md) §9）。
- 淘汰观战者仅获得公开牌局状态与最终排名（《区块6-10 v0.2》§7.18）；P1 AI 使用独立 `BotView`，同信息边界（《区块6-10 v0.2》§7.9）。
- 投影必须**从服务端源头删除**未授权信息，严禁"先发送再用 CSS 隐藏"（《总规划》附录 B 红线 2）。
- 验收：字段级测试——任何非授权 Payload 不含其他底牌、Deck、Burn Card 或服务端私密字段（[06](./06-testing-strategy.md) §7；《总规划》§9.1；《区块6-10 v0.2》§9.13）。
- 投影器是只读组件：从 GameState 读、产出投递对象，不做状态变更（§4 原则）。

## 12. 持久化编排

表结构、写入节奏与失败语义权威在 [03](./03-data-model.md)；本文只规定编排职责：

- 唯一写者：只有 game-server 连接 Postgres（[03](./03-data-model.md) §9）。
- Tournament 执行器只在内存原子提交之后，把不可变持久化任务追加给 Persistence Writer；Action 热路径不等待 DB。每桌写入顺序与 event `sequence` 一致（[03](./03-data-model.md) §7.1）。
- P0 以整手为原子提交单元：手末把 `hands` 行、该手全部 `hand_events`、结果更新与 `game_snapshots` 组成不可变 Commit Bundle，在单个 DB 事务中提交；Snapshot.sequence 必须等于该手最后一个事件。元数据状态转换使用独立的幂等写任务（[03](./03-data-model.md) §4.2/§7）。
- 每个写任务有稳定幂等键（至少包含 `tournamentId + handNumber/transition + targetSequence`）；超时或连接中断后允许安全重试，不得插入重复 Hand/Event 或倒序覆盖较新状态。
- 无真人关房时持久化 Hand History 与断开原因（§6.5；《总规划》§4.2）。

### 12.1 重试、观测与有序性

- 单个 Tournament 的任务严格串行写入；不同 Tournament 最多 8 路并发。单次 DB 尝试 5 秒超时；失败按 `250ms × 2^attempt` 指数退避、加入 ±20% jitter、最高 30 秒，恢复后从最旧未提交任务继续。
- 至少暴露 `queueItems`、`queueBytes`、`oldestPendingAge`、`lastCommittedSequence`、连续失败次数和 DB 延迟指标，并按 Room/Tournament 关联结构化日志；不得把完整私有牌面写进普通告警日志。
- Writer 不丢弃、不覆盖未提交 Commit Bundle；重试失败不回滚内存 GameState，也不重放已执行 Action。

### 12.2 背压与资源硬限

- 持久化队列同时按任务数、估算字节数和最旧任务年龄执行 §10.3 的 watermarks；任一维度达到阈值即视为命中。
- 达到 soft watermark：触发告警并进入 `PERSISTENCE_DEGRADED` 内部状态，停止创建新 Room 和启动新 Tournament；已开始的 Hand 继续运行与结算。
- 达到 hard watermark：为避免 OOM 或无界丢失面，不再开始下一 Hand；受影响 Tournament 在当前 Hand 安全结算并形成 Commit Bundle 后停在 Hand 边界持续重试。hard watermark 的内存预算必须预留“每张活跃桌完成当前 Hand 所需的最坏情况 Bundle”空间，不能等内存耗尽才触发。恢复到 soft watermark 以下后才可继续。
- 因此“DB 失败不锁桌”的精确定义是：单次或短暂写失败不阻塞 Action、不回滚当前 Hand；资源安全硬限允许在 Hand 边界受控暂停。不得以无限内存队列实现表面上的永不暂停。

## 13. 进程生命周期与崩溃恢复

- **启动屏障**：恢复完成前不接受创建/加入/Action。按 `rooms`/`tournaments` 元数据定位活跃比赛，只选择 [03](./03-data-model.md) §4.3 定义的最新“整手已完整提交”Commit Bundle；校验版本、checksum、事件连续性与 Snapshot.sequence，孤立 Snapshot、部分事务或事件缺口一律拒绝并回退到上一个可验证检查点。
- **进行中 Hand 崩溃**：P0 不回放 Snapshot 之后未完整提交的 Hand Events。恢复到最近手末 Snapshot 后，丢弃崩溃 Hand 的内存牌面、Action、Timer 与未提交事件，再以新的随机结果开始下一 Hand；该丢弃 Hand 不进入 Hand History。若首手尚无手末 Snapshot，则从已持久化的 Tournament 配置和锁定参与者重新初始化比赛。
- **恢复后重建**：从 Snapshot 中恢复 Tournament 全局 sequence、盲注进度、Dealer/参与者/筹码等 Engine 状态；重新建立 Tournament 执行器与未来 Timer，不恢复旧进程 Timer 回调或 `connectionEpoch`。所有连接均视为断开，客户端重新认证并接受新的 Snapshot 屏障，清空旧动画与待发送 Action。
- **运行期重连**：内存投影，不读 DB（[03](./03-data-model.md) §4.3）。
- **无法验证恢复根**：不得猜测拼接状态或用不完整数据继续发牌；隔离该 Tournament、记录 Critical 诊断并拒绝其 Action，等待人工处置。其他 Room/Tournament 正常启动。

### 13.1 优雅关停

收到 `SIGTERM`/`SIGINT` 后按以下固定顺序执行，总硬期限 120 秒：

1. 立即把 Readiness 置为失败，停止新 WS Upgrade、创建/加入 Room 和启动 Tournament；已有连接与当前 Hand 暂时保留。
2. 所有 Tournament 设置 `stopAfterCurrentHand=true`，不再开始下一 Hand。当前 Hand 继续按原 Action/Timer 规则运行，最多等待 90 秒；关停不能擅自缩短玩家时间或制造规则外 Auto Fold。
3. 当前 Hand 在 90 秒内结束时形成完整 Commit Bundle 并停在 Hand 边界；所有桌均到达边界后立即进入 Flush。90 秒到期仍未结束的 Hand 不生成部分 Snapshot，按 §13 的崩溃恢复语义整体舍弃。
4. 停止业务命令，向连接发送可重试的 `GAME_UNAVAILABLE`，以 Close 1012 关闭；Persistence Writer 最多再 Flush 30 秒。
5. 已提交 DB 的 Bundle 才是恢复根；Flush 超时不得写半事务或延长进程到编排器强杀之外，记录未提交 Bundle 数量后退出。下次启动从最新完整手末恢复。

收到第二次终止信号只缩短到当前 Flush 阶段，不绕过 DB 事务原子性。Liveness 在进程实际退出前保持成功，Readiness 从步骤 1 起保持失败。

### 13.2 终局内存卸载

- Tournament 进入 `FINISHED`/`ABANDONED_NO_HUMAN` 后立即取消 Timer/AI、拒绝新动作，并把最终状态复制进不可变持久化任务。旧 Tournament Runtime 转只读保留 10 分钟，供已连接客户端完成最终 Snapshot/事件同步；之后即使 DB 重试仍在进行也可卸载，因为 Writer 持有独立 Bundle。
- Room `FINISHED → LOBBY` 后可立即创建新 Tournament；旧 Runtime 的只读保留不能占据“活跃 Tournament”名额，也不能接收新 Room 的命令。
- Room 进入 `CLOSED` 后立即移除邀请码路由、使 Token 失效并关闭连接；完成正在执行的队列任务后卸载重型 Room/Tournament Runtime，同时保留轻量 `{roomId, closedReason, closedAt}` Tombstone 10 分钟，用于拒绝迟到请求，之后删除。
- 卸载前必须满足：无正在提交的内存状态转移、所有 Timer generation 已失效、连接已解绑、持久化任务已复制到 Writer。不得仅因 JS 对象“无人引用”而把资源回收交给偶然的 GC 时机。

## 14. P1 AI 接入点

- AI Controller 在服务器运行，和真人 Action 一样进入 Engine（《总规划》§8）；以 `ActionSource=BOT_CONTROLLER` 进同一串行队列（§7.5）。
- P0 仅启用 `HUMAN` 与 `HUMAN_SOCKET/SYSTEM_TIMER`，不接 API、不显示 AI 控件；`participant.kind = HUMAN | BOT` 从第一天建模（《总规划》§6）。
- 无真人 → 立即停止后续 AI 决策与计时任务（§6.5；《总规划》§4.2/§8）。
- AI 只能选择 Engine 给出的合法 Action，不能直接修改筹码、牌、Pot 或 Dealer（《总规划》§6）。
- 推理、Poker Context 构造、JSON Schema 校验与 Fallback 细节归 P1 `server/ai`（《总规划》§8），本文只定接入边界。

## 15. Failure Handling

| 失败场景 | 检测方式 | 处理 | 对牌局可见的结果 |
| --- | --- | --- | --- |
| 重复 Action | `actionId` + Payload 摘要 | 相同 Payload 复用原 `COMMAND_RESULT`；不同 Payload 拒绝 | `duplicate: true` / `IDEMPOTENCY_KEY_REUSE`，无二次副作用（[02](./02-protocol-spec.md) §7.3） |
| 过期 Action | `expectedSequence` 校验 | 拒绝并下发最新 Snapshot | `STALE_GAME_STATE` |
| 超时与 Action 竞争 | `receivedAt`、`ingressOrdinal` 与单调时钟裁决（§7.2） | 截止前 Action 优先于同一 Deadline Timer；逾期不执行 | `ACTION_TIMEOUT` / `STALE_GAME_STATE` |
| 行动超时 | Scheduler（§8.1） | Auto Check / Auto Fold（`SYSTEM_TIMER`） | 自动动作入 Hand History |
| 断线 | WS 关闭 | §9.3；宽限计时；牌局继续 | `DISCONNECTED`，不阻塞整桌 |
| 断线满 10 分钟 / 主动离开 | 计时器 / `LEAVE_ROOM` | `EXIT_PENDING` → `WITHDRAWN`（§6.6） | 座位保留至安全结算点 |
| 无真人 | 状态检查 | `CLOSED` / `ABANDONED_NO_HUMAN`；停 AI 与计时 | 邀请码失效 |
| Timer 误触发 | 执行前状态校验（§8.2） | 丢弃，无副作用 | 无 |
| 旧设备接管后继续发命令 | `connectionEpoch` 校验 | 拒绝旧 epoch；通知并关闭旧连接 | `SESSION_REPLACED` |
| Engine 拒绝 Action | Action Validation | 不执行、状态不变 | 错误码（[02](./02-protocol-spec.md) §11） |
| Engine Critical Error | Invariants 断言 | 冻结该 Hand、保存诊断；server 停止该桌执行 | 该桌冻结 + 诊断（[01](./01-engine-spec.md) §16） |
| DB 短暂故障 | 写入失败 | 当前 Hand 继续；Commit Bundle 有序重试，不回滚 | 通常无感（§12.1） |
| DB 长期故障/队列硬限 | items/bytes/age watermark | 停止新建；当前 Hand 结算后在边界暂停 | 服务降级但进程不 OOM（§12.2） |
| 进程崩溃 | 重启 | 仅恢复最新完整手末 Commit Bundle，丢弃未提交 Hand | Snapshot 回退至最近手末（§13） |
| 事件积压 | 队列深度/滞后时长 | Fast Forward 到最新 Snapshot（§9.5） | 客户端快照 |
| 邀请码枚举 / Action 刷 | Rate Limit（§10.3） | 拒绝 | 错误码 |

## 16. Invariants（game-server 层）

| 不变量 | 表述 | 依据 |
| --- | --- | --- |
| 串行唯一 | 同一 Tournament 的状态变更、Timer、AI Action 均经唯一串行队列 | 《总规划》§5.2；红线 3 |
| Room 串行唯一 | 同一 Room 的成员、Ready、配置、Host、状态迁移与 Tournament 创建均经唯一 Room 队列 | 本文 §5.7 |
| 计时权威 | 服务器单调时钟唯一权威；`receivedAt` 不可伪造 | 《总规划》§3.2 |
| 幂等执行 | Tournament 在当前进程驻留期间，同一 `tournamentId + playerId + actionId` 至多执行一次；重复请求复用原结果 | 《总规划》§3.2；[02](./02-protocol-spec.md) §7.3 |
| 投影完整 | 任何投递 Payload 不含接收者无权获得的信息（字段级） | 《总规划》§5.3 |
| 单活跃连接 | 一个 `playerToken` 至多一个活跃控制连接 | 《区块6-10 v0.2》§7.17 |
| 接管隔离 | 提交 HUMAN_SOCKET Action 时的 `connectionEpoch` 必须仍为该玩家当前 epoch | [02](./02-protocol-spec.md) §10 |
| 断线不动牌局 | 断线只改 `ConnectionStatus`，扑克状态不变 | 《区块6-10 v0.2》§6.3 |
| 引擎边界 | server 不得绕过 Engine 修改规则状态；只经 Action 通道 | 《总规划》红线 1 |
| 内存权威 | DB 永不回写或取代内存权威状态 | [03](./03-data-model.md) §8 |
| 序列单调 | 同桌 Event `sequence` 单调递增、与状态转移顺序一致 | [02](./02-protocol-spec.md) §14 |
| 手末提交完整 | 可恢复 Snapshot 只来自包含该手完整 Events 的原子 Commit Bundle | [03](./03-data-model.md) §4.3/§7 |

校验位置：串行/幂等/序列由 [02](./02-protocol-spec.md) §14 与 [06-testing-strategy.md](./06-testing-strategy.md) §6 测试项覆盖；投影完整性由 06 §7 字段级测试覆盖（《总规划》§9.1；《区块6-10 v0.2》§9.13）。

### 16.1 本文新增裁决的最低验证集

- 并发 Room 命令：两个开局请求最多创建一场活跃 Tournament；并发加入不突破容量/昵称唯一约束；旧 Tournament 的终局信号不能覆盖新 Tournament。
- Deadline 边界：覆盖 `D-1/D/D+1`、Timer 先入队但截止前 Action 仍等待、同截止点多个 Action、截止前非法 Action 后 Timer 生效。
- 接管：旧连接 Action 已排队但未提交时发生新设备接管，旧 epoch 必须拒绝；通知丢失也不能恢复旧连接控制权。
- 持久化：事务部分失败、重复重试、乱序完成、soft/hard watermark、DB 恢复后继续，均不得产生重复 Event、Snapshot 错位或内存回滚。
- 崩溃恢复：首手中崩溃、普通 Hand 中崩溃、完整 Bundle 后崩溃、孤立 Snapshot、事件缺口与 checksum/版本不识别；只允许从最新可验证手末恢复。
- 参数边界：行动时间五档与 `UNLIMITED`、Time Bank 四档、单行动最多使用一次、邀请代码连续冲突 10 次、Host 断线 `59_999/60_000ms` 边界。
- 连接背压：15/45 秒心跳、Fast Forward 的 `64 Event/5s/256KiB` 三个独立触发器、`1MiB/30s` Close 1013，以及慢连接不影响同桌其他连接。
- 容量与关停：100 Room/1,000 WS SLO、130/1,300 安全余量、各 hard limit 的拒绝行为、90 秒 Hand drain + 30 秒 Flush、终局/Tombstone 10 分钟卸载。

## 17. Security Considerations

- **信任边界**：客户端不可信；所有输入先 Schema Validate 再进业务层，动作再校验身份/回合/金额（[02](./02-protocol-spec.md) §13；红线 4）。
- **身份**：`playerToken` 高熵签发、仅签发时交予本人；连接建立必须校验；客户端不能指定 Seat（[02](./02-protocol-spec.md) §5/§4）。
- **限流**：邀请码枚举与 Action 刷（§10.3）。
- **私有信息**：投影在服务端源头删除（§11；红线 2）；原始 `hand_events`/`game_snapshots` 永不直投客户端（[03](./03-data-model.md) §9）。
- **密钥与日志**：DeepSeek API Key 只存服务端环境变量（P1）；API Key、`playerToken` 不进日志（[02](./02-protocol-spec.md) §5/§11；《区块6-10 v0.2》§8.5/§8.11）。
- **规则唯一权威**：server 自身代码也不得绕过 Engine 改筹码/牌/Pot/Dealer（红线 1）。

## 18. Known Limitations

- 单实例模块化单体：无水平扩容、多区域部署；每桌串行是唯一并发模型（《区块6-10 v0.2》§7.20）。
- 进行中 Hand 崩溃无损恢复非 P0 硬要求（《总规划》§7.2）。
- 进程崩溃会整体丢弃尚未形成完整 Commit Bundle 的进行中 Hand；恢复到最近手末，而非拼接部分事件（[03](./03-data-model.md) §4.3）。
- P0 无 BOT；AI 接入点仅为预留，不接 API（《总规划》§6）。
- §10.3 的容量数值是 P0 单实例保护默认值，必须以目标机器压测校准；它们不是水平扩展或 SLA 承诺。
- 单桌 Critical Error 冻结只影响该桌，不影响其他桌（设计意图，§7.4）。

## 19. Design Notes（为什么）

- **为什么一桌一队列而不是全局锁**：故障隔离与可测试性——单桌状态串行在内存最简单、最快（《区块6-10 v0.2》§7.13/§7.20）；全局锁会把单桌故障放大为全服故障。
- **为什么 Lobby 也需要 Room 队列**：开局前尚无 Tournament 队列，但加入、Ready、改配置与开局同样存在并发检查后写入问题；Room 队列保证最多创建一场活跃 Tournament，并以 `roomRevision` 提供客户端可观察顺序（§5.7）。
- **为什么 Timer 也是队列任务**：超时与 Action 的竞争裁决只有一处（§7.2），否则 Timer 直接 mutate 会绕过串行与幂等（《总规划》§3.2）。
- **为什么裁决点在服务端接收**：可重放、与网络快慢一致（《总规划》§3.2）。
- **为什么 server 计时权威**：客户端时钟不可信；`actionDeadline` 必须由唯一时钟维护（《总规划》§3.2；《区块6-10 v0.2》§7.14）。
- **为什么投影在 server 源头**：信任边界在服务端，不依赖前端配合（红线 2；[02](./02-protocol-spec.md) §9）。
- **为什么 DB 短暂失败不阻塞当前 Hand、但资源硬限可在手末暂停**：DB 是记录层，不应进入 Action 热路径；同时内存与丢失窗口不能无限增长，因此以完整 Hand 为降级边界（§12.2；[03](./03-data-model.md) §7）。
- **为什么 P0 就建模 BOT 与三种 ActionSource**：P1 只是"在现有座位加入 BOT 参与者"，房间/协议/Engine 均不因 AI 改写（《总规划》§1/§6）。

## 20. 原待决项的最终裁决

本文没有剩余待决项。保留原编号以便与历史评审记录对应；实现和测试必须采用下表，不得在代码中另选默认行为：

| # | 最终裁决 | 规范落点 |
| --- | --- | --- |
| 1 | WS Ping 每 15 秒；45 秒无 Pong/有效入站帧即断线 | §9.6 |
| 2 | 有限行动时间为 `15/20/30/45/60` 秒，默认 30 秒；另允许 `UNLIMITED` | §8.3 |
| 3 | Time Bank 单次延长最多 30 秒，每个行动机会最多成功一次 | §8.4 |
| 4 | `USE_TIME_BANK` 是 Tournament 队列中的 Server 控制命令，不进入 Engine Action 联合类型 | §7.5/§8.1 |
| 5 | 撤回使用 Tournament 级 `WithdrawParticipant` Engine 指令 | §6.6 |
| 6 | `sequence` 在单个 Tournament 内跨 Hand 全局递增，新 Tournament 从 1 开始 | §7.3 |
| 7 | Fast Forward：64 个待发事件、最旧 5 秒或 256KiB 任一命中；1MiB/持续 30 秒则 Close 1013 | §9.5 |
| 8 | 31 字符字母表、6 位 CSPRNG 邀请码、数据库唯一约束、最多 10 次完整重试 | §5.2 |
| 9 | 限流、Payload、in-flight、连接/Room/Tournament、幂等账本与持久化 watermark 采用 P0 默认参数表 | §10.3/§12.2 |
| 10 | 关停总期限 120 秒：当前 Hand 最多 90 秒 + Persistence Flush 30 秒；未结束 Hand 整体舍弃 | §13.1 |
| 11 | 终局 Tournament 只读保留 10 分钟；CLOSED Room 保留轻量 Tombstone 10 分钟 | §13.2 |
| 12 | Lobby 房主断线宽限 60 秒；到期转给最早加入且在线的真人 | §5.5 |
| 13 | 采用 §4.1 的固定模块目录与 kebab-case/PascalCase/lowerCamelCase 命名规则 | §4.1 |
| 14 | `requestId`/`actionId` 幂等账本保留整个 Runtime 驻留期；不得 LRU/TTL 淘汰，极端容量通过受控 recycle 处理 | §7.3/§10.3 |

## 21. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 技术栈与目录名 | 《区块6-10 v0.2》§10.1/§10.2/§10.5：Vite + React、Zustand、`apps/server` | 《总规划》§6：Node.js + Fastify + `@fastify/websocket`、`apps/game-server` | 以《总规划》为准（与 [02](./02-protocol-spec.md) §18 冲突 1 同族，本文只记服务端侧面） |
| 2 | 文档编号 | [02](./02-protocol-spec.md) §2.2/§7 曾写"串行队列、Scheduler、Timer 的实现属 `apps/game-server`（未来 03 文档）" | 03 已被数据模型占用（[03](./03-data-model.md) §2.2 已改称"未来 04 文档"） | 编号落定：**本文即 04**；已回改 02 两处引用 |
| 3 | 退出后参赛者语义（服务端侧面） | 《区块1-5 v0.1》§4.8：退出后 Sitting Out，继续缴盲自动 Fold 至自然淘汰 | 《总规划》§4.1：断线满 10 分钟或主动离开 → `EXIT_PENDING` → `WITHDRAWN` + `forfeitedChips` | 以《总规划》为准（与 [01](./01-engine-spec.md) §21 冲突 1 同族，本文落实 10 分钟断线计时器与 §6.6 流程） |
| 4 | Time Bank 消耗方式 | 《区块6-10 v0.2》§7.15：按 20/30 秒一段消耗 | 《总规划》§3.1：一次延长固定时段（如 30 秒）或剩余余额中较小者 | 以《总规划》为准；工程值固定为每次最多 30 秒、每个行动机会最多一次（§8.4） |

### 本轮工程定稿补充（2026-08-21）

以下事项为上游规划未明确或旧版 04 仍悬置、但服务端实现不能留给代码偶然决定的工程裁决；若后续改变，必须同步更新 01/02/03/06 的对应契约与测试：

| # | 裁决 | 落点 |
| --- | --- | --- |
| 1 | Room/Lobby 与 Tournament 使用两级、每实体串行执行器；跨队列只单向投递带期望 ID 的命令，不同时持锁 | §4/§5.7/§7.1 |
| 2 | 超时胜负只看服务端 `receivedAt` 相对 Deadline；截止前 Action 即使仍排队也优先，`ingressOrdinal` 处理同点顺序 | §7.2 |
| 3 | `actionId` 保存 Payload 摘要与最终结果至 Tournament 卸载；重复请求复用结果，键复用不同 Payload 拒绝 | §7.3 |
| 4 | Time Bank 是 Server 控制命令；撤回是 Tournament 级 `WithdrawParticipant`；两者都不伪装成下注 Action | §6.6/§7.5/§8.1 |
| 5 | 多设备接管使用 `connectionEpoch`；旧 epoch 尚未提交的命令在执行前失效 | §9.2 |
| 6 | P0 持久化以整手 Commit Bundle 原子提交；短暂失败不阻塞当前 Hand，资源硬限在 Hand 边界受控暂停 | §12 |
| 7 | 崩溃只恢复最新可验证手末 Bundle，整体丢弃未提交 Hand，重建执行器/Timer/连接状态 | §13 |

《总规划》v1.0 新增、docx 未覆盖的决策（本文已吸收）：Action 与超时竞争的四步裁决（§3.2）；`ABANDONED_NO_HUMAN`、`CLOSED` 后邀请码立即失效、停 AI 与计时（§4.2）；断线满 10 分钟 `EXIT_PENDING`（§4.1）；不限时强制禁用 Time Bank（§3.1）；P0 开局 ≥2 真人、房主不能绕过 Ready 强制开始（§2.1）；房主转移规则（§4.2）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。
