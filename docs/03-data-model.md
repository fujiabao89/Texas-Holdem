# 03 · 数据模型与持久化规格（`apps/game-server` / Supabase Postgres）

> 状态：草稿（表结构与持久化仓储已实现 · TEX-18；运行时写入编排/恢复语义仍为设计意图）
> 规划核对：2026-08-21（Engineering Documentation Agent）；实现核对：2026-08-23（TEX-18）
> 权威范围：本文是持久化模型的唯一权威来源——内存运行 vs PostgreSQL 持久化的边界、写入节奏与失败语义、核心表（`rooms` / `room_players` / `tournaments` / `tournament_players` / `hands` / `hand_events` / `game_snapshots` / `ai_requests`）的字段级设计与实现事实、敏感数据存放与暴露规则。范围之外的事实见 [工程文档总索引](./README.md)：Engine 内存状态域属 [01](./01-engine-spec.md) §4，wire Schema、投影与凭证契约属 [02](./02-protocol-spec.md) §5/§6/§9/§13，串行队列与 Timer 实现属 [04](./04-game-server-architecture.md)，AI 推理属 P1 `server/ai`。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§4.2/§5.1/§6/§7.2）；《德州扑克项目规划_区块6-10_v0.2.docx》§7.19/§8.5/§8.11/§8.12/§10.10/§10.11（仅在《总规划》未覆盖处补充）；《德州扑克项目规划_区块1-5_v0.1.docx》§1.5/§3.8/§4.2（身份与单人恢复的持久化侧面）
> 对应代码：`apps/game-server/src/infrastructure/persistence/`（Drizzle schema、迁移、连接/事务、仓储；见该目录 README）
> 上级索引：[工程文档总索引](./README.md)

> **【实现现状 · TEX-18，2026-08-23】** §5 全部 8 张表、枚举、复合外键（含两个 DEFERRABLE 循环外键）、CHECK、部分唯一索引与最小权限已由版本化迁移落地并经真实 PostgreSQL 集成测试核对（§15 项 1/2/3/7 达成）；控制面原子写入与手末 Commit Bundle 仓储已实现（Bundle 内参赛者结果更新按 `id + tournament_id` 匹配并断言受影响行数，拒绝跨赛修改与静默无效更新，§7.4）。**仍为设计意图**：§4.2/§7.1–7.2 的运行时写入编排（异步 Writer/队列/watermark）、§4.3/§7.5 的恢复流程、§5.10 清理任务、§7.6–7.7 失败降级（属 TEX-19～TEX-22）。各表字段表与规格一致，实现补充以"实现注记"标出。

> **【实现现状 · TEX-22，2026-08-25】** 运行时写入编排与崩溃恢复已落地：异步 Writer（§7.1–7.2 顺序性/幂等重试/失败语义，§7.7 背压 soft/hard watermark）、恢复流程（§4.3/§7.5）与「向前退回」的 `rollbackToSnapshot`（§7.5 恢复回退语义注记）。恢复读取仓储在 `apps/game-server/src/infrastructure/persistence/repositories/recovery.ts`；Writer 与恢复编排在 `apps/game-server/src/persistence/`（见该目录 README）。**仍属后续任务**：§5.10 保留期清理、Hand History 投影读取、Room/Lobby 内存态恢复（成员/Host/配置 → RoomManager）、§7.6 soft watermark 下"已开房间内启动新 Tournament"的拒绝门控（当前仅拦新 Room 创建）。

## 1. Purpose

P0 的持久化策略是"**内存运行 + 关键状态持久化**"（《区块6-10 v0.2》§7.19）：唯一真实 GameState 在 game-server 内存中串行演进，PostgreSQL 保存的是"能重建比赛、分析牌局或定位问题的数据"（§10.10），而不是运行时的权威状态。本文把这条边界写成可实现的契约：

- 明确**内存权威、DB 记录**的分层：健康运行期内 DB 不参与状态裁决、不回滚已生效 Action；只有进程启动/崩溃恢复才从 DB 重建内存状态。单次/短暂 DB 故障不阻塞当前 Hand，资源达硬限时允许在手间边界受控暂停（§8.12；[02](./02-protocol-spec.md) §12）。
- 给《区块6-10 v0.2》§10.10 点名的 7 张记录表及本文补齐的 `room_players` 一份字段级设计意图，并标注哪些字段是服务器私有信息。
- 锁定写入节奏（控制面先提交、Hand Events 按手异步原子提交、每手末写 Snapshot）与崩溃恢复语义（《总规划》§7.2）。

## 2. Responsibilities / Non-Responsibilities

### 2.1 负责

| 职责 | 依据 |
| --- | --- |
| 内存 vs 持久化边界：什么进 DB、什么只在内存 | 《区块6-10 v0.2》§7.19/§10.10 |
| 核心记录表与字段级设计意图（规划点名 7 表 + 身份关系表 `room_players`） | 《区块6-10 v0.2》§10.10；本文身份约束推导 |
| 写入节奏与失败语义（短暂 DB 故障不阻塞当前 Hand；硬限在手间暂停） | 《区块6-10 v0.2》§8.12；《总规划》§6 |
| Snapshot 检查点与崩溃恢复语义 | 《总规划》§7.2 |
| 敏感数据（playerToken、API Key、隐藏牌信息）的存放与暴露规则 | 《区块6-10 v0.2》§8.5/§8.11；[02](./02-protocol-spec.md) §5/§13 |
| P1 AI 用量统计（`ai_requests`）字段 | 《区块6-10 v0.2》§8.14/§9.19 |

### 2.2 不负责（及归属）

| 不负责 | 归属 | 依据 |
| --- | --- | --- |
| Engine 内存状态域结构（chips/streetBet/Pots/…） | [01](./01-engine-spec.md) §4 | 《区块6-10 v0.2》§6.3 |
| wire Schema 与投影（`PlayerView`/`BotView`） | [02](./02-protocol-spec.md) §6/§9 | 《总规划》§5.3 |
| 串行队列、Scheduler、Timer 实现 | `apps/game-server`（[04](./04-game-server-architecture.md)） | 《总规划》§3.2/§6 |
| AI 推理与 Prompt 构造 | P1 `server/ai` | 《总规划》§8 |
| 纯前端 UI 状态（动画过程、窗口大小等） | 不保存 | 《区块6-10 v0.2》§10.10 |

## 3. Dependencies

| 依赖 | 类型 | 用途 | 失效影响 |
| --- | --- | --- | --- |
| Supabase Postgres | 基础设施 | 唯一持久化存储 | DB 不可用 → 按 §7/§10 降级；当前 Hand 可完成，hard watermark 后在手间暂停，新 Room/身份/Tournament 操作失败 |
| Drizzle ORM + `pg` | 数据访问 | game-server 的类型化查询、显式事务与行锁；不经浏览器 Supabase Client 写表 | ORM 失配或 transaction API 误用 → 原子 Commit Bundle 契约破坏 |
| Drizzle Kit | Schema migration | 生成/管理版本化 SQL migration；migration SQL 纳入代码审查 | migration 偏离本文 → DDL 与契约不一致 |
| `poker-engine` GameState 序列化 | 内容来源 | Snapshot 内容来自 Engine 状态域（[01](./01-engine-spec.md) §4） | 序列化不完整 → 快照无法恢复 |
| `packages/protocol` Event/ErrorCode 类型 | 类型引用 | `hand_events.type`/`payload` 与事件目录对齐（[01](./01-engine-spec.md) §14） | 事件落库与 wire 不一致 |
| game-server 串行执行器 | 运行时调用方 | 唯一写者；所有写入发生在状态转移之后 | DB 并发写 → 破坏事件顺序 |

反向约束：`poker-engine` 不得依赖数据库（[01](./01-engine-spec.md) §3）；客户端永不直连 DB（§9）。

## 4. 总体模型：内存权威 + PostgreSQL 记录

### 4.1 分层

- **权威层（内存）**：每桌 GameState、Event 序列、Timer、连接映射，全部在 game-server 内存中串行演进（[02](./02-protocol-spec.md) §7/§10；《区块6-10 v0.2》§7.13）。运行期内存是唯一真实状态；进程重启时，最新已提交 Snapshot 是新内存状态的恢复根。
- **记录层（PostgreSQL）**：Room/Tournament 元数据、Hand History、Snapshot、比赛结果与 P1 AI 用量（《总规划》§6）。角色是持久记录与崩溃恢复检查点。
- **读取路径**：用户可读的历史/快照必须经过投影（[01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9）——原始表数据永不直接投递客户端。

### 4.2 写入节奏

| 数据 | 节奏 | 依据 |
| --- | --- | --- |
| `rooms` / `tournaments` 元数据与状态转换 | 状态转换点写（创建、开局、FINISHED、CLOSED/ABANDONED） | 《总规划》§4.2/§5.1 |
| `tournament_players` 结果 | 淘汰/撤回/终局时更新 | [01](./01-engine-spec.md) §12/§13 |
| `hand_events` | 异步或按 Hand 批量持久化 | 《区块6-10 v0.2》§8.12 |
| `game_snapshots` | 每手结束写一条 | 《总规划》§7.2；《区块6-10 v0.2》§7.19 |
| `ai_requests`（P1） | 每次 LLM 调用结束后追加 | 《区块6-10 v0.2》§8.14 |

### 4.3 恢复语义

- **运行期重连**（刷新/切网/后台恢复）：game-server 用内存最新状态投影下发（[02](./02-protocol-spec.md) §6/§10），不依赖 DB 读取。
- **进程崩溃后**：若 `last_committed_sequence > 0`，从对应的最新“整手已完整提交”手末 Snapshot 恢复；若仍为 0（首手尚未完整提交），从已持久化的 Tournament 配置和锁定参赛者重新初始化。P0 的 Hand Events 与手末 Snapshot 以整手为一个原子提交单元，因此恢复时不回放 Snapshot 之后的未提交/进行中 Hand Events；崩溃时进行中的 Hand 无损恢复**不是 P0 硬要求**（《总规划》§7.2；[02](./02-protocol-spec.md) §15）。
- 每手末 Snapshot 是持久化检查点的下限粒度。《总规划》§7.2 将其与刷新、切网和手机后台恢复同时提及；本文的精确分工是：进程存活时这些场景使用内存最新投影，手末 DB Snapshot 只为进程重启/崩溃恢复托底。

恢复实现必须拒绝孤立 Snapshot、事件缺口或 checksum/版本不可识别的提交单元，并向前退回到上一个可验证的 Snapshot；不得猜测或拼接部分状态。

## 5. 核心表（设计意图）

总览：《区块6-10 v0.2》§10.10 点名 7 张记录表；本文增加 `room_players` 作为 Room 级身份与成员关系表，以便使 Host、重连凭证、昵称唯一性和跨场 Tournament 身份具有明确的外键语义。

> **实现注记（TEX-18）**：8 张表已全部由迁移 `0000_init.sql` 落地（snake_case 列名与下表字段一一对应；`*At` → `*_at`）。所有外键 `ON DELETE RESTRICT`；`bigint` 列在 Drizzle 层以原生 `bigint` 处理。表定义不带 schema 前缀，目标 schema（生产 `game`、测试 `tex_test_<runId>`）由连接 `search_path` 决定，因此同一迁移可用于任意隔离 schema。

| 表 | 目的 | 写入时机 | 内容敏感度 |
| --- | --- | --- | --- |
| `rooms` | 房间容器：邀请码、状态、配置、Host | 创建/状态转换 | 低（邀请码是 Locator 非凭证，[02](./02-protocol-spec.md) §5） |
| `room_players` | Room 级成员身份、昵称、重连凭证摘要 | 加入/离开 | **高（凭证摘要服务器私有）** |
| `tournaments` | Room 内一次实际比赛：配置快照、结果 | 创建/开局/结束 | 低 |
| `tournament_players` | 参赛记录：Seat、身份引用、昵称快照、筹码、排名 | 参赛/淘汰/撤回 | 中（含玩家身份与结果，不含 token 摘要） |
| `hands` | 每手元数据：手号、Dealer、盲注、公共牌 | 手结束 | 低（不含隐藏牌） |
| `hand_events` | 完整结构化事件流（含诊断级隐藏信息） | 异步/按手批量 | **高（服务器私有）** |
| `game_snapshots` | 手末完整 GameState 检查点（含隐藏信息） | 每手结束 | **高（服务器私有）** |
| `ai_requests` | P1 LLM 调用用量与降级统计 | 每次调用后 | 中（不含 API Key） |

### 5.1 `rooms`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK | — |
| `mode` | enum：MULTIPLAYER/SINGLE_PLAYER | P0 只启用 `MULTIPLAYER`；P1 单人模式复用同一 Room/Tournament 持久化链路 | §13 决策 7 |
| `invite_code` | text nullable | `MULTIPLAYER` 时必填且长度恰为 6；当前有效房间内唯一，用部分唯一索引 `UNIQUE(invite_code) WHERE status <> 'CLOSED' AND mode = 'MULTIPLAYER'` 保证；大写字母/数字、排除 0/O、1/I/L 等易混淆字符。`SINGLE_PLAYER` 时必须为 NULL，不可被加入接口枚举。`CLOSED` 后邀请码立即失效且允许未来复用；它只定位房间，非身份凭证 | 《总规划》§5.1；《区块1-5 v0.1》§4.2；[02](./02-protocol-spec.md) §5 |
| `status` | enum：CREATED/LOBBY/IN_GAME/FINISHED/CLOSED | 生命周期 `CREATED → LOBBY → IN_GAME → FINISHED → LOBBY`；Lobby 或无真人时可转 `CLOSED` | 《总规划》§5.1；《区块1-5 v0.1》§4.11 |
| `config_json` | jsonb | 房间当前比赛配置（形状 = `TournamentConfig`，[01](./01-engine-spec.md) §12）；Lobby 展示与"再来一局"复用；`IN_GAME` 期间冻结，回到 Lobby 后可为下一场修改，已开局配置始终以 `tournaments.config_json` 为准 | 《总规划》§5.1/§7.1 |
| `host_player_id` | uuid nullable FK → room_players.id | 比赛前房主；离开时转给最早加入且在线的真人；比赛中 Host 无特权、只是普通参赛者。用 `(id, host_player_id)` → `room_players(room_id, id)` 的复合外键（可延迟检查）保证 Host 属于本 Room | 《总规划》§4.2 |
| `closed_reason` | text nullable | 服务端原因码；`status=CLOSED` 时必填，P0 至少实现 `ABANDONED_NO_HUMAN`。新增原因码必须先更新契约/测试，不存自由文本或堆栈 | 《总规划》§4.2 |
| `created_at` | timestamptz | 创建时间 | 设计意图 |
| `closed_at` | timestamptz nullable | `status=CLOSED` 时必填，其他状态必须为 NULL | 设计意图 |
| `retention_expires_at` | timestamptz nullable | `CLOSED` 时设为 `closed_at + 180 days`；未关闭时为 NULL | §5.10/§13 决策 13 |

Room 与首个 Host 的建立必须放在同一事务中：先插入 `rooms(host_player_id = NULL)`，再插入 `room_players`，最后回填 Host；复合外键设为 `DEFERRABLE INITIALLY DEFERRED`。

> **实现注记（TEX-18）**：已实现——`RoomRepository.createRoomWithHost` 按上述三步单事务写入；DEFERRABLE 复合外键 `rooms_host_player_fk` 由手写迁移 `0001` 追加（Drizzle 无法表达循环依赖外键，故 Drizzle schema 中不声明）。邀请码以 CHECK 强制：MULTIPLAYER 必填且匹配 `^[A-HJKMNPQRSTUVWXYZ2-9]{6}$`（对 NULL 显式拒绝——`NULL ~ 正则` 为 NULL、CHECK 三值逻辑会放行）、SINGLE_PLAYER 必须 NULL。`CLOSED` 与 `closed_reason`/`closed_at`/`retention_expires_at` 的一致性由跨字段 CHECK 强制（`retention_expires_at >= closed_at` 弱校验，精确 180 天策略由应用层保证）；无真人关房经 Commit Bundle 的 `tournamentFinish.roomClosure` 在同一事务写齐关房元数据，缺失、错配、时间倒挂（`retention_expires_at < closed_at`）或空/含控制字符的原因码均在写入前被拒绝（§7.3）。

P1 单人模式也创建 `rooms`、`room_players`、`tournaments` 及后续 Hand 记录：`rooms.id` 同时就是单人恢复契约中的 `gameId`，唯一 HUMAN 是 Host，BOT 使用同 Room 下的 `room_players(kind=BOT)` 和 `tournament_players`。不新建一套 `single_player_games` 表，不绕过本文的 Commit Bundle、Snapshot、AI 用量与保留策略。

### 5.2 `room_players`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK，即协议中的 `playerId`；在一个 Room 会话内跨场 Tournament 稳定 | 《总规划》§5.2 |
| `room_id` | uuid FK → rooms.id | 身份仅属于一个 Room；`UNIQUE(room_id, id)` 供复合外键引用 | 身份三元组推导 |
| `display_name` | text（2–16 个 Unicode grapheme clusters） | 经服务端校验的展示值 | 《区块1-5 v0.1》§1.5/§4.3 |
| `display_name_key` | text | 昵称的 NFKC + Unicode case-fold 值；`UNIQUE(room_id, display_name_key)` 防止规范化/大小写意义上的重名，不声称防御所有 Unicode 同形字 | 服务端身份约束 |
| `kind` | enum：HUMAN/BOT | 从第一天建模；HUMAN 有凭证，BOT 无客户端凭证 | 《总规划》§6 |
| `token_digest` | bytea nullable | HUMAN 的高熵随机 `playerToken` 使用 HMAC-SHA-256 生成的 32-byte 摘要；原 token 永不落盘；BOT 为 NULL | [02](./02-protocol-spec.md) §5 |
| `token_key_id` | text nullable | 标识 HMAC 服务端密钥版本，用于密钥轮换；密钥本身只在服务端 Secret 中 | 安全设计 |
| `status` | enum：ACTIVE/LEFT | `LEFT` 保留历史引用，禁止再以旧凭证建立新连接 | 主动离开语义 |
| `left_reason` | enum nullable：USER_LEFT/DISCONNECT_TIMEOUT/ROOM_CLOSED | `status=LEFT` 时必填；用于持久化断开/离开原因 | 《总规划》§4.2 |
| `joined_at` | timestamptz | 用于 Host 转移的最早加入排序；并列时按 `id` 升序 | 《总规划》§4.2 |
| `left_at` | timestamptz nullable | `status=LEFT` 时必填，`ACTIVE` 时必须为 NULL | 设计意图 |

- 连接/在线状态仍只在内存；`room_players` 记录身份与成员关系，不使 PostgreSQL 成为 Presence 系统。

> **实现注记（TEX-18）**：已实现。规格中 `token_digest`/`token_key_id` 标注 nullable，实现将"HUMAN 有凭证、BOT 无凭证"强化为 CHECK：`kind='HUMAN'` 时两者必填、`kind='BOT'` 时必须为 NULL；`octet_length(token_digest)=32` 亦由 CHECK 强制。`UNIQUE(room_id, id)` 供 `rooms_host_player_fk` 引用。HMAC 摘要计算/常数时间比较与 NFKC+小写 `display_name_key` 规范化（近似 case-fold，不声称防御所有 Unicode 同形字，与规格口径一致）由 persistence 模块工具提供；`playerToken` 的 CSPRNG 生成与下发属 TEX-19。
- 服务端使用 CSPRNG 生成至少 256-bit 随机熵的 `playerToken`，仅在创建/加入 Room 的成功 HTTP 响应中返回原值。校验时对明确编码的 `room_id || player_id || playerToken` 按 `token_key_id` 计算 HMAC-SHA-256，并与 `token_digest` 常数时间比较。原 token 不可由摘要恢复；客户端丢失 token 即无法恢复该匿名身份，P0 不提供昵称找回。HMAC 校验密钥至少保留到其所属 Room 关闭；轮换策略不得使未关闭 Room 的现有 token 意外失效。
- 用户输入在入库前完成长度、字符集与 Unicode 规范化校验；输出时仍必须按所在上下文转义。

### 5.3 `tournaments`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK | — |
| `room_id` | uuid FK → rooms.id | Room 是容器、Tournament 是实际比赛；"再来一局"新建 Tournament，不复用旧牌局状态 | 《总规划》§5.1；《区块6-10 v0.2》§7.3 |
| `tournament_no` | int | Room 内第 N 场（"再来一局"递增）；`UNIQUE(room_id, tournament_no)` | 设计意图（§7.3 推论） |
| `status` | enum：IN_GAME/FINISHED/ABANDONED_NO_HUMAN | 无真人 → 记录为 `ABANDONED_NO_HUMAN`，不把 AI 宣告为冠军 | 《总规划》§4.2 |
| `config_json` | jsonb | 该场 `TournamentConfig` 快照：`maxPlayers`、`startingStack`、`smallBlind`、`bigBlind`、`blindMode`、`blindStructure`、`actionTime`、`timeBank`；服务端最终 Schema Validation 后写入；开局后锁定 | [01](./01-engine-spec.md) §12；《区块6-10 v0.2》§10.11；《总规划》§2.3 |
| `champion_tournament_player_id` | uuid FK nullable → tournament_players.id | 仅剩一名有效参与者即冠军；服务端与复合约束必须保证其属于本 Tournament | 《总规划》§2.2 |
| `started_at` | timestamptz | Tournament 开始时间 | 设计意图 |
| `finished_at` | timestamptz nullable | `FINISHED`/`ABANDONED_NO_HUMAN` 时必填；结束后 Room 可回 Lobby 再开一场 | 《总规划》§5.1 |
| `retention_expires_at` | timestamptz nullable | 终态时设为 `finished_at + 180 days`；`IN_GAME` 时为 NULL | §5.10/§13 决策 13 |
| `last_committed_sequence` | bigint | Tournament 开始时为 0，表示尚无已提交 Hand/Snapshot；大于 0 时是最新已原子提交的手末 Event Sequence，必须与最新 Snapshot 对齐 | 恢复水位线 |

> **实现注记（TEX-18）**：已实现。跨字段 CHECK 强制 `IN_GAME ↔ finished_at/retention_expires_at 为 NULL`、`champion 仅 FINISHED`、`last_committed_sequence >= 0`；`UNIQUE(id, room_id)` 供复合外键引用。DEFERRABLE 冠军外键 `tournaments_champion_tournament_player_fk` 由迁移 `0001` 追加。`TournamentRepository.createTournamentWithPlayers` 以单事务写入 Tournament（`last_committed_sequence=0`）与 locked players；Commit Bundle 的终局更新在写入前校验 `retention_expires_at >= finished_at` 与时间有效性（与 `tournaments_retention_check` 对齐，但前置拒绝而非整包写入后回滚）。

### 5.4 `tournament_players`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK（行身份） | — |
| `tournament_id` | uuid FK → tournaments.id | — | — |
| `room_id` | uuid | 用于可声明的复合外键：`(tournament_id, room_id)` → `tournaments(id, room_id)`；不允许与 Tournament 所属 Room 不一致 | 关系完整性 |
| `player_id` | uuid FK → room_players.id | 协议中的 Room 级玩家身份；`UNIQUE(tournament_id, player_id)`；`(room_id, player_id)` → `room_players(room_id, id)`，禁止跨 Room 引用 | 《总规划》§5.2 |
| `display_name` | text（2–16 字符） | 本场开局时的昵称快照；不用于身份校验，Room 内唯一性由 `room_players` 保证 | 历史可读性 |
| `seat_index` | smallint（0–9） | 固定 Seat；空位/真人/AI/淘汰者都有稳定 `seatIndex`；开局后不换座；`UNIQUE(tournament_id, seat_index)` 且 `CHECK (seat_index BETWEEN 0 AND 9)` | 《总规划》§2.1 |
| `kind` | enum：HUMAN/BOT | 开局时的类型快照；P0 仅 `HUMAN`，P1 在现有座位加入 `BOT` | 《总规划》§6 |
| `starting_stack` | bigint | 该场初始筹码；`CHECK (starting_stack > 0)` | [01](./01-engine-spec.md) §12 |
| `final_stack` | bigint nullable | 终局或 `WITHDRAWN` 时刻的剩余在场筹码；未终结前可为 NULL，有值时必须 `>= 0` | 设计意图（结果重建） |
| `forfeited_chips` | bigint | `WITHDRAWN` 时未投入的剩余筹码，不赠与他人；默认 0 且 `CHECK (forfeited_chips >= 0)` | [01](./01-engine-spec.md) §13；《总规划》§4.1 |
| `poker_status` | enum：ACTIVE/ELIMINATED/WITHDRAWN | `chips == 0` ≠ `ELIMINATED`（可能正在 All-in）；`EXIT_PENDING` 为运行时过渡态，通常只在安全结算点以 `WITHDRAWN` 落库 | [01](./01-engine-spec.md) §4.3/§12/§13 |
| `rank` | int nullable | 最终名次；同手多淘汰按该手开始筹码多者高、相同按 `seatIndex` 升序打破并列，因此名次唯一；非 NULL 时要求 `rank > 0` 并用部分唯一索引保证同 Tournament 不重复 | 《总规划》§2.1 |
| `eliminated_hand_id` | uuid FK nullable | 淘汰发生的那一手；非 NULL 时 `(eliminated_hand_id, tournament_id)` → `hands(id, tournament_id)` | 设计意图 |
| `created_at` / `updated_at` | timestamptz | — | 设计意图 |

- 连接状态（`ConnectionStatus`）**不落库**：连接是运行时概念，与 `PokerStatus` 解耦（[01](./01-engine-spec.md) §4.3；[02](./02-protocol-spec.md) §10）。
- `playerToken` 与昵称永不进入日志（[02](./02-protocol-spec.md) §13）；凭证摘要仅位于 `room_players`，不复制到每场参赛记录。

> **实现注记（TEX-18）**：已实现。`rank` 唯一性由部分唯一索引 `UNIQUE(tournament_id, rank) WHERE rank IS NOT NULL` 保证；`eliminated_hand_id` 的复合外键 `(eliminated_hand_id, tournament_id) → hands(id, tournament_id)` 已落地。`updated_at` 由仓储在更新时显式写入（无触发器）。昵称快照入库前经与 `room_players` 相同的 `validateDisplayName` 校验（本表无 DB CHECK 兜底，运行时输入不豁免）；手末 Commit Bundle 的结果更新按 `id + tournament_id` 匹配并断言恰好一行，跨赛 id 或未知 id 整体回滚（§7.4）。

### 5.5 `hands`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK | — |
| `tournament_id` | uuid FK → tournaments.id | — | — |
| `hand_number` | int | 手号（[01](./01-engine-spec.md) §4.1 `handNumber`）；`UNIQUE(tournament_id, hand_number)` 且 `CHECK (hand_number > 0)` | 《区块6-10 v0.2》§6.3 |
| `dealer_seat` | smallint | 本手 Dealer；`CHECK (dealer_seat BETWEEN 0 AND 9)` | [01](./01-engine-spec.md) §4.1 |
| `sb_seat` / `bb_seat` | smallint | 本手 SB/BB；可由 `dealer_seat` + 存活玩家推导（Heads-Up 规则见 [01](./01-engine-spec.md) §11），冗余存储便于历史展示；均限制在 0–9 | 设计意图 |
| `blind_level_index` | int | 本手生效的盲注层级；盲注允许下降且只在两手之间变更 → 必须按手记录 | [01](./01-engine-spec.md) §12；《总规划》§2.3 |
| `small_blind` / `big_blind` | bigint | 本手生效盲注快照；`CHECK (small_blind > 0 AND big_blind > small_blind)` | 《总规划》§2.3 |
| `community_cards` | jsonb | 手末最终公开牌面（0–5 张）；未到 River 就结束时不人工补牌 | [01](./01-engine-spec.md) §4.1 |
| `summary` | jsonb | 结算摘要（各 Pot 金额/赢家/牌型/`bestFiveCards`）；作为查询投影在手末事务内冗余保存，内容必须由同一 Engine 输出生成并与 `hand_events` 一致。只能包含按规则已公开的牌面；未 Show 的 Hole Cards/基于其计算的 `bestFiveCards` 不入此字段 | [01](./01-engine-spec.md) §9/§10 |
| `end_reason` | enum：ALL_FOLDED/SHOWDOWN/ABANDONED | 显式区分未发满公共牌的正常结束与异常终止 | 历史查询与诊断 |
| `started_at` / `ended_at` | timestamptz | — | 设计意图 |

- **隐藏信息不入此表**：Burn 牌面与未公开底牌只存在于 `hand_events` 诊断负载与 `game_snapshots.state`（服务器私有，§6）。

> **实现注记（TEX-18）**：已实现。`community_cards` 以 CHECK 强制为 0–5 张 JSON 数组；`blind_level_index` 增加 `>= 0` CHECK；`hands(tournament_id, hand_number DESC)` 定向索引按 §5.9 建立。
- 用户版 Hand History 从 `hands` + `hand_events` 读取时投影（[01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9）。

### 5.6 `hand_events`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | bigint identity | PK（事件量大；uuid 亦可，实现自选） | 设计意图 |
| `tournament_id` | uuid FK → tournaments.id | Event Stream 的持久化作用域；一场 Tournament 对应一个连续 Stream | [02](./02-protocol-spec.md) §14 |
| `hand_id` | uuid FK → hands.id | 事件归属手；`(hand_id, tournament_id)` → `hands(id, tournament_id)` 保证两者一致；淘汰/比赛结束事件归属发生当手 | 设计意图 |
| `sequence` | bigint | Tournament Event Stream 从 1 开始跨 Hand 严格递增，与状态转移顺序一致；`UNIQUE(tournament_id, sequence)` | [02](./02-protocol-spec.md) §7.1/§14 |
| `hand_sequence` | int | 本手内从 1 开始连续递增；`UNIQUE(hand_id, hand_sequence)`，用于快速验证整手事件无缺口 | 持久化完整性 |
| `type` | text | 事件目录唯一权威在 [01](./01-engine-spec.md) §14（`HAND_STARTED`/`DEAL_HOLE_CARD`/`BURN_CARD`/…） | 《区块6-10 v0.2》§6.12 |
| `payload` | jsonb | 结构化负载；服务器内部完整流可含 Burn 牌面、`DEAL_HOLE_CARD` 实际牌面等诊断信息 → 服务器私有 | [01](./01-engine-spec.md) §14；《区块6-10 v0.2》§8.11 |
| `schema_version` | int | Event `type/payload` 的持久化 Schema 版本；写入时必须通过对应版本校验 | 升级/回放兼容性 |
| `created_at` | timestamptz | — | 设计意图 |

- 第一版即保存**完整**结构化 Event（§6.12），作为运行期动画流的持久化对应物，并服务 Hand History、AI 历史、调试与未来 Replay（[01](./01-engine-spec.md) §14）。运行期断线恢复使用内存 Snapshot/Event，不查这张表。

> **实现注记（TEX-18）**：已实现。`id` 选用 `bigint GENERATED ALWAYS AS IDENTITY`（§5.6 允许实现自选）；`sequence`/`hand_sequence`/`schema_version` 增加 `> 0` CHECK；`UNIQUE(hand_id, hand_sequence)` 与 `(hand_id, tournament_id) → hands(id, tournament_id)` 复合外键已落地。
- 不保存动画过程、窗口大小等纯前端 UI 状态（§10.10）。

### 5.7 `game_snapshots`

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | uuid | PK | — |
| `tournament_id` | uuid FK → tournaments.id | — | — |
| `hand_id` | uuid FK → hands.id | 该检查点对应的已完整提交 Hand；`(hand_id, tournament_id)` → `hands(id, tournament_id)` | 《总规划》§7.2 |
| `sequence` | bigint | 等于该手最后一个 Event Sequence，且大于 0；为重启恢复水位线 | [02](./02-protocol-spec.md) §6 |
| `state` | jsonb | 完整内部 GameState 序列化（含 Deck 顺序、底牌等隐藏信息）→ 服务器私有 | 《总规划》§7.2；[02](./02-protocol-spec.md) §9 |
| `schema_version` | int | Snapshot 序列化格式版本 | 恢复兼容性 |
| `engine_version` | text | 生成该 Snapshot 的 `poker-engine` 版本/构建标识 | 规则升级可追溯性 |
| `state_checksum` | bytea | 对稳定序列化结果计算的 32-byte SHA-256；恢复前必须验证 | 损坏检测 |
| `commit_checksum` | bytea | 对本提交单元的 Hand 元数据、按序 Events、Snapshot 状态及相关结果变更做稳定序列化后计算 32-byte SHA-256 | 幂等与完整性验证 |
| `created_at` | timestamptz | 每手结束写一条 | 《总规划》§7.2 |

- `UNIQUE(tournament_id, hand_id)` 保证每手至多一个已提交手末快照；`UNIQUE(tournament_id, sequence)` 防止恢复水位线歧义。
- Snapshot 的状态边界是“结算、淘汰/Withdraw、盲注层级调整均已应用，下一手 `HAND_STARTED` 尚未发生”。这个边界必须在 Engine 序列化测试中固定。
- checksum 输入使用统一的 canonical JSON/字节编码，字段顺序和数值表示必须可重现；排除 DB 自动生成的 identity/`created_at`，包含 Tournament/Hand/Sequence 等自然幂等键。
- 进程崩溃后从最新可验证的已提交 Snapshot 恢复（§4.3）。P0 不使用该 Snapshot 之后、不属于完整手末提交的事件。

> **实现注记（TEX-18）**：已实现。`octet_length(state_checksum/commit_checksum)=32`、`sequence > 0`、两个唯一约束（`(tournament_id, hand_id)`、`(tournament_id, sequence)`）均已落地。canonical JSON（键排序、BigInt 十进制）与 SHA-256 工具由 persistence 模块提供；Commit Bundle 仓储在提交前验证事件序列与水位线咬合并以 `commit_checksum` 判定幂等重试（§7.3/§7.4），恢复读取路径属 TEX-22。
- 活跃 Tournament 保留全部 Snapshot 便于损坏时向前退回；Tournament 终态 7 天后删除中间 Snapshot，只保留 `sequence` 最大的最后一条；该最后 Snapshot 与 Tournament 其他历史在终态 180 天后一起删除（§5.10）。

### 5.8 `ai_requests`（P1）

| 字段 | 类型（设计意图） | 语义与约束 | 依据 |
| --- | --- | --- | --- |
| `id` | bigint identity | PK | 设计意图 |
| `tournament_id` | uuid FK → tournaments.id | — | — |
| `tournament_player_id` | uuid FK → tournament_players.id | 发起调用的 BOT 席位；`(tournament_id, tournament_player_id)` → `tournament_players(tournament_id, id)` 保证属于本 Tournament | 《总规划》§8 |
| `hand_id` | uuid FK nullable | 调用时所在手；非 NULL 时 `(hand_id, tournament_id)` → `hands(id, tournament_id)` | 设计意图 |
| `provider` / `model` | text | 第一版 `deepseek`；字段为多 Provider 预留 | 《区块6-10 v0.2》§10.9 |
| `input_tokens` / `output_tokens` | int nullable | 用量统计；Provider 未返回用量时可为 NULL，有值时必须 `>= 0` | 《区块6-10 v0.2》§9.19 |
| `latency_ms` | int | 延迟统计；`CHECK (latency_ms >= 0)` | 同上 |
| `status` | enum：SUCCESS/FALLBACK | 是否使用 LLM 结果或服务端降级策略 | 《区块6-10 v0.2》§8.4 |
| `fallback_reason` | enum nullable：TIMEOUT/HTTP_ERROR/INVALID_JSON/ILLEGAL_ACTION/PROVIDER_ERROR | `status=FALLBACK` 时必填，`SUCCESS` 时必须为 NULL | 《区块6-10 v0.2》§8.4 |
| `provider_status_code` | int nullable | HTTP Provider 的非敏感状态码；不保存响应原文 | 诊断需求 |
| `cost` | numeric(18,8) nullable | 成本估算（每场 Tournament 成本统计），统一以美元记录；价格未配置时可为 NULL，有值时必须 `>= 0` | 《区块6-10 v0.2》§9.19 |
| `created_at` | timestamptz | — | 设计意图 |

- 不存 API Key、Prompt/Response/Reasoning 原文或其他玩家的私有上下文（《区块6-10 v0.2》§8.5）。调试仅使用上述结构化用量、延迟、状态与降级原因；如未来确需保存原文，必须通过新的安全设计审查和独立表/保留策略，不得直接扩展本表。
- 只有唯一合法动作时不调用 LLM → 不产生记录（《区块1-5 v0.1》§3.7）。

> **实现注记（TEX-18）**：表与全部约束已随 `0000_init.sql` 按规格落地（含 `FALLBACK ↔ fallback_reason` CHECK、非负用量/延迟/成本 CHECK、`(tournament_id, tournament_player_id)` 与 `(hand_id, tournament_id)` 复合外键、`(tournament_id, created_at)` 索引）；P0 无写入方，P1 启用时无需再迁移。

### 5.9 通用约束、索引与变更规则

- **NULL 默认规则**：除字段表显式写明 `nullable` 外，所有字段均为 `NOT NULL`；表中声明的默认值必须在 DDL 中落实，不只依赖应用层补值。
- **可声明的关系完整性**：DDL 必须增加 `tournaments(id, room_id)`、`tournament_players(tournament_id, id)`、`hands(id, tournament_id)` 等复合 `UNIQUE` 键，以实现本节声明的同 Room/同 Tournament 复合外键。`rooms.host_player_id` 和 `tournaments.champion_tournament_player_id` 的循环外键在相关表创建后通过 migration 追加，并使用可延迟检查的复合外键保证所属关系。
- **删除策略**：所有历史外键默认 `ON DELETE RESTRICT`，禁止业务路径级联删除 Room/Tournament/Player/Hand。保留期到期后只能由独立清理任务按“AI 统计 → Snapshot → Events → 清空 Champion 反向引用 → Tournament Players → Hands → Tournament → 清空 Host 反向引用 → Room Players → Room”的显式顺序删除。大量子行可分批删；清空反向引用与删除对应被引用行必须在同一收尾事务中完成。
- **不可变数据**：已提交的 `hands`、`hand_events`、`game_snapshots` 是 append-only；除保留期清理和经审核的 Schema 迁移外不允许 UPDATE/DELETE。`config_json`、Event `payload`、Snapshot `state` 在写入前必须通过对应版本的服务端 Schema Validation；DB 另对非负数、枚举、数组长度等可表达条件加 `CHECK`。
- **跨字段 CHECK**：至少覆盖 `room_players.kind/status/token_digest/token_key_id/left_reason`、`rooms.mode/invite_code/status/closed_reason/closed_at/retention_expires_at`、`tournaments.status/champion_tournament_player_id/finished_at/retention_expires_at/last_committed_sequence`、`game_snapshots.hand_id/sequence` 与 `ai_requests.status/fallback_reason`，禁止产生枚举与 nullable 字段自相矛盾的行。`token_digest`、`state_checksum`、`commit_checksum` 非 NULL 时要求 `octet_length(...) = 32`。
- **时间**：所有 `*_at` 使用 `timestamptz NOT NULL DEFAULT now()`（语义允许 NULL 的终止时间除外），以 DB 时间为持久化审计时间；Event 业务顺序只看 `sequence`，不用时间戳排序。
- **数值边界**：`sequence`/筹码在 PostgreSQL 使用 `bigint`，但 Node.js/协议层不得默认转为可丢精度的 JS `number`。`sequence` 按 [02](./02-protocol-spec.md) §4.1 以十进制字符串传输；筹码仍是 wire `number`，因此配置、下注、Pot 与总筹码都必须在 `Number.MAX_SAFE_INTEGER` 内，入库前与 DB `CHECK` 双重验证。`numeric(18,8)` 成本以 decimal/string 处理，不用二进制浮点做账务聚合。
- **必要索引**：先复用主键/唯一约束已有索引；另至少建立 `room_players(room_id, status, joined_at, id)`、`tournament_players(tournament_id)`、`hands(tournament_id, hand_number DESC)`、`ai_requests(tournament_id, created_at)`、`rooms(retention_expires_at) WHERE retention_expires_at IS NOT NULL` 和 `tournaments(retention_expires_at) WHERE retention_expires_at IS NOT NULL`。若查询规划器不能有效反向扫描现有 `(tournament_id, sequence)` 唯一索引，再增加 Snapshot 的定向索引。具体执行计划在真实数据量下用 `EXPLAIN (ANALYZE, BUFFERS)` 验证。
- **Drizzle 落地规则**：Schema 定义与业务查询使用 Drizzle ORM，底层驱动固定为 `pg`；Commit Bundle 使用同一 `pg` Client/连接上的显式事务，不得跨连接拼接。Drizzle 无法表达的部分索引、DEFERRABLE 复合外键、CHECK 或 `SELECT ... FOR UPDATE` 使用受审查的 SQL migration/参数化 SQL，不得为了“纯 ORM”删弱约束。Drizzle Kit 生成的 SQL 必须纳入版本控制和 code review；禁止对生产库使用未审查的 schema push。

> **实现注记（TEX-18）**：已按此落地——迁移 `0000`（Drizzle Kit 生成后人工审查修正）+ `0001`（DEFERRABLE 复合外键，手写）+ `0002`（最小权限，手写），全部纳入版本控制并登记于 Drizzle journal；生产执行走 `db:migrate`（drizzle-orm migrator + `DATABASE_SCHEMA`），不使用 schema push。审查清单（去 `public.` 前缀、复合 FK 晚于被引用唯一索引、UTF-8 无 BOM 等）见 `apps/game-server/src/infrastructure/persistence/migrations/README.md`。`SELECT ... FOR UPDATE` 经 Drizzle `.for("update")` 用于 Commit Bundle 的 Tournament 行锁。

### 5.10 保留与清理策略

| 数据 | 保留规则 | 说明 |
| --- | --- | --- |
| 活跃 Room/Tournament 及其全部子记录 | 不按 TTL 删除 | 不得删除活跃比赛的恢复根或凭证摘要 |
| 终态 Tournament 的中间 Snapshot | `finished_at + 7 days` 后删除 | 只保留 sequence 最大的最后 Snapshot；若一手都未提交则无 Snapshot |
| 终态 Tournament、Tournament Players、Hands、Hand Events、最后 Snapshot、AI Requests | `finished_at + 180 days` 后删除 | `FINISHED` 与 `ABANDONED_NO_HUMAN` 使用同一规则；`retention_expires_at` 为扫描水位 |
| 已关闭 Room 及 Room Players | `closed_at + 180 days` 后删除 | 只有当所属 Tournament 已按规则清理或同批次删除时才能删除；token 在 Room 关闭时已立即失效，180 天是历史保留期而非凭证有效期 |
| 主库删除后的托管备份副本 | 最多再保留 30 天 | 部署时必须选择/配置不超过该上限的 Supabase 备份策略；备份不用于绕过业务 TTL 恢复已过期数据 |

清理任务每日至少运行一次，使用 `retention_expires_at` 与小批量上限扫描，遵守 §5.9 的 RESTRICT 外键和显式删除顺序。单批失败只重试该批，不跳过父子关系；清理延迟、失败数和最旧过期记录年龄必须可观测并告警。若未来引入法务/安全保留锁，必须以显式字段、审计记录和新 migration 扩展，不允许临时手工跳过清理任务。

## 6. 敏感数据存放与暴露规则

| 数据 | 内存 | DB | 客户端/AI | 日志 |
| --- | --- | --- | --- | --- |
| `playerToken` | game-server（校验重连） | 仅 `room_players.token_digest` HMAC 摘要 + `token_key_id`；原值不落盘 | 仅创建/加入成功时交给本人（[02](./02-protocol-spec.md) §5） | **禁止**（[02](./02-protocol-spec.md) §13） |
| DeepSeek API Key | 服务端环境变量 | 不存 | 永不 | **禁止**（《区块6-10 v0.2》§8.5；[02](./02-protocol-spec.md) §5） |
| 未公开 Hole Cards / Fold 后未公开底牌 | Engine/Server | `hand_events` 诊断负载、`game_snapshots.state`（服务器私有） | 仅投影允许的接收者（[02](./02-protocol-spec.md) §9） | 内部诊断可；用户可见输出禁止 |
| Burn 牌面 / Deck 顺序 | Engine/Server | 同上（服务器私有） | 永不（[01](./01-engine-spec.md) §7） | 内部诊断可；对外禁止 |
| AI Prompt/Response/Reasoning | `server/ai` 调用期间短暂存在 | **不存原文**；只存结构化用量/结果元数据 | 永不（[02](./02-protocol-spec.md) §9） | **禁止** |
| 昵称 | — | 校验转义后入库 | 展示 | — |

总则：

- **存完整、读投影**：服务器内部保留完整诊断数据（含 Burn 牌面，用于复现；《区块6-10 v0.2》§8.11），任何面向玩家的历史/快照读取必须经过投影（[01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9）。
- 原始 `hand_events` / `game_snapshots` 永不直接投递客户端（[02](./02-protocol-spec.md) §9）。
- P0 的用户版 Hand History 在读取时由 `hands.summary` + 经接收者权限投影的 `hand_events` 生成，不额外持久化用户版缓存；产生性能瓶颈后再引入带 `projection_version` 的可丢弃派生缓存。

## 7. 写入顺序与一致性

1. **顺序性**：所有持久化任务由串行执行器在状态转移生效后构造，并按 Tournament Event `sequence` 提交（[02](./02-protocol-spec.md) §14）。DB 工作器可异步执行，但不得使同一 Tournament 的后续手越过前一手提交，也不得为了腾出内存丢弃或覆盖未提交 Commit Bundle。
2. **控制面先提交**：Room 创建、玩家加入、Host 转移和 Tournament 开始必须先在 DB 事务中提交，再向客户端确认成功。Tournament 开始事务同时写入 Tournament（`last_committed_sequence=0`）与参赛快照；首个 Snapshot 仍在第 1 手完整提交时生成。DB 不可用时这些新操作失败，但不影响已在进行的 Tournament。
3. **手末原子提交**：每手结束时，在一个 PostgreSQL 事务内先锁定对应 Tournament 行（`SELECT ... FOR UPDATE`），再写入 `hands` 行 + 该手全部 `hand_events` + 一条 `game_snapshots` + 该手造成的 `tournament_players` 淘汰/名次变更 + `tournaments.last_committed_sequence`；如该手终结比赛，同事务更新 Tournament/Room 结果状态。提交前必须验证 `hand_sequence` 从 1 到 `count(*)` 无缺口、首个 Tournament `sequence = 上一水位线 + 1`、末个 `sequence = Snapshot.sequence`。任一语句或验证失败则整个事务回滚，不存在可恢复的“半手”。
4. **幂等重试**：任务在内存中携带预先生成的 `hand_id`/`snapshot_id`与确定性 Event 序列；重试使用原 ID 和唯一约束，结果必须是“全部首次插入”或“已完整提交且 `commit_checksum` 相同”。出现部分冲突或同 ID 不同内容时不得静默 `ON CONFLICT DO NOTHING`，必须标记数据损坏并告警。
5. **恢复顺序**：先读 `rooms`/`room_players`/`tournaments`/`tournament_players` 元数据。当 `last_committed_sequence=0` 时，从锁定配置/参赛者重新初始化；大于 0 时，读取对应 Snapshot → Schema/Engine 版本与 checksum 验证 → 构造内存 GameState。若水位线对应的 Snapshot 不可用，按 `sequence` 向前查找最近可验证 Snapshot；P0 不尝试恢复未提交的进行中 Hand。

> **实现注记（TEX-22）**：恢复语义已落地——对快照校验 `schema_version`/`engine_version` 兼容、`state_checksum` 一致（对解析后状态对象的 canonical 序列化复算）、`hasCommittedEventsThrough(tournamentId, sequence)` 事件连续性、`state.nextSequence == snapshot.sequence` 序列对齐；任一失败即拒绝并向前退回。**向前退回合**语义：当最新可验证 Snapshot 的 `sequence < last_committed_sequence`（最新损坏/孤立/缺口）时，`rollbackToSnapshot` 在单事务内删除 `sequence > 回退点` 的 `hand_events`/`hands`/`game_snapshots`、复位 `last_committed_sequence`，并按快照引擎参与者重置 `tournament_players`（`pokerStatus/finalStack/rank/forfeitedChips`；`eliminatedHandId` 无法从快照精确还原置 NULL；`forfeitedChips` 从保留区域 `PLAYER_WITHDRAWN` 事件重构）。无可验证恢复根时隔离该 Tournament、拒绝其动作、记录 Critical（docs/04 §13）。
6. **失败语义（核心）**：**单次/短暂 DB 失败不得阻塞当前 Hand**（《区块6-10 v0.2》§8.12；[02](./02-protocol-spec.md) §12）——GameState 在内存继续执行，写入任务进入有界内存队列并指数退避重试；DB 写失败不回滚内存状态、不重放 Action。长时间故障达 hard watermark 后按 §7.7 在手间边界暂停。
7. **背压与手间暂停**：队列按任务数、估算字节数和最旧任务年龄设 soft/hard watermark。达 soft watermark 时告警、停止创建新 Room 与启动新 Tournament，已开始的 Hand 继续。达 hard watermark 时，每个受影响 Tournament 允许当前 Hand 安全结算并形成完整 Commit Bundle，然后在手间边界暂停，直到队列回落到 soft watermark 以下。Writer 不丢弃、不覆盖 Bundle；hard watermark 内存预算必须为每张活跃桌预留完成当前 Hand 的最坏情况空间。

队列的字节/手数上限、退避参数和告警阈值由 [04](./04-game-server-architecture.md) 实现规格锁定；本文锁定其行为语义。

## 8. Invariants（数据模型层）

| 不变量 | 表述 | 依据 |
| --- | --- | --- |
| 运行期内存权威 | DB 在健康运行期只是记录层，不参与 Action 裁决；只在进程启动/崩溃恢复时成为内存状态的输入 | 《区块6-10 v0.2》§7.19/§8.12 |
| 手末提交完整 | 已提交的 Hand 必须同时具有 `hands` + 连续完整 `hand_events` + 对齐 Snapshot；不暴露部分提交 | 《区块6-10 v0.2》§6.12 |
| 快照对齐 | `last_committed_sequence=0` 表示尚无 Snapshot；大于 0 时，最新 Snapshot.sequence == 该手最后一个 `hand_events.sequence` == `tournaments.last_committed_sequence` | 设计意图（[02](./02-protocol-spec.md) §6 重连契约） |
| 可重建 | `rooms` + `room_players` + `tournaments` + `tournament_players` + 最新可验证 `game_snapshots` 足以恢复活跃比赛；`hands` + `hand_events` 足以分析所有已提交牌局与定位问题 | 《区块6-10 v0.2》§10.10 |
| 投影完整 | 用户可读的历史/快照读取路径必须投影；原始行不得进入任何不受信任的客户端或 AI 上下文 | [01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9 |
| 敏感隔离 | `playerToken` 与 API Key 不进日志；API Key 不进 DB | [02](./02-protocol-spec.md) §13；《区块6-10 v0.2》§8.5 |

## 9. Security Considerations

- **唯一写者**：只有 game-server 服务端连接 Postgres（Supabase 数据层在服务端组织）；客户端永不直连 DB、无任何 SQL 权限（《总规划》§6；[02](./02-protocol-spec.md) §13）。
- **Supabase 硬隔离**：所有表放在不暴露给 PostgREST/GraphQL 的私有 Schema；若部署约束必须使用暴露 Schema，则对 `anon`/`authenticated` 撤销 Schema/Table/Sequence 权限并开启默认拒绝 RLS。只授予 game-server 专用 DB Role 最小必要权限；不得把 Supabase service-role key 发给浏览器。迁移测试必须以 `anon`/`authenticated` 角色验证所有原始表均不可读写。
- **原始表是服务器私有资源**：`hand_events`/`game_snapshots` 包含隐藏信息，任何对外接口（Hand History、未来 Replay）必须走投影读取路径（[01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9）。
- **凭证**：`playerToken` 仅以 HMAC 摘要落库（§5.2）；HMAC Key 与 DeepSeek API Key 只存服务端 Secret Manager/环境注入，不进 DB、日志或客户端（《区块6-10 v0.2》§8.5）。
- **备份与运维**：包含隐藏牌的备份、逻辑复制流和运维导出与生产库同等敏感；启用静态/传输加密，限制下载角色并记录审计日志。生产数据禁止直接复制到未受控的开发/测试环境。
- **XSS**：昵称服务端校验 + 输出转义（[02](./02-protocol-spec.md) §13）。
- P0 不引入 Supabase Auth，沿用 `playerId + playerToken`（《总规划》§6）。
- 邀请码枚举由加入接口 Rate Limit 防御（[02](./02-protocol-spec.md) §13），与表结构无关。

> **实现注记（TEX-18）**：已实现并测试——迁移 `0002` 以 `current_schema()` 动态执行：对 `PUBLIC`/`anon`/`authenticated` REVOKE schema 与全部表/序列权限（含 DEFAULT PRIVILEGES），仅向 `game_server` 角色授予 schema USAGE + 表 DML + 序列 USAGE。集成测试以 `SET ROLE anon/authenticated` 实测每张原始表读写均被 `permission denied` 拒绝，`game_server` 角色可正常运行。Supabase 部署时 `game_server` 需由 DBA 以 LOGIN + 密码预先创建（密码只进连接串）。

## 10. Failure Handling

| 失败场景 | 检测方式 | 处理 | 对牌局可见的结果 |
| --- | --- | --- | --- |
| DB 不可用（连接断/超时） | 写入失败 | 已开局牌局继续；手末任务队列重试；控制面新操作返回服务不可用（§7.2/§7.6） | 旧牌桌无感，新 Room/加入/开局失败 |
| 手末提交中任一写入失败 | 事务失败 | 整个 Hand 提交回滚，使用原 ID/Sequence/checksum 重试；不暴露部分提交 | 无感（崩溃恢复点滞后） |
| 队列超过 soft watermark | items/bytes/age 指标 | 告警；已开始 Hand 继续；停止创建新 Room/启动新 Tournament | 旧牌桌暂时无感，新建/开局返回服务不可用 |
| 队列达到 hard watermark | items/bytes/age 指标 | 当前 Hand 安全结算并入队后，Tournament 停在手间边界重试；不丢弃 Bundle | 当前 Hand 可完成，之后显示服务暂停/恢复中 |
| 进程崩溃 | 重启 | 按 `last_committed_sequence` 取快照并验证；不可用则向前退回；进行中/未提交 Hand 丢失被接受（§4.3） | 恢复到最近可验证手末 |
| 无真人关房 | 状态转换 | `rooms.closed_reason` 与 `tournaments.status=ABANDONED_NO_HUMAN` 持久化；已完成的 Hand History 与断开原因保存 | 房间 `CLOSED`，邀请码失效 |
| 历史读取泄露 | 读取路径审计 | 只允许投影读取；字段级测试（[06](./06-testing-strategy.md) §7；《区块6-10 v0.2》§9.13） | 无泄露 |

## 11. Known Limitations

- 进行中 Hand 崩溃不保证无损恢复（《总规划》§7.2）。
- 单实例模块化单体：无多实例共享状态、无水平扩容（《区块6-10 v0.2》§7.20）。
- 异步手末提交意味着进程崩溃可能丢失所有尚在内存队列中的完整 Hand，客户端重连后可观察到状态回退至最新已提交检查点。长时间 DB 故障时会在手间边界受控暂停，不主动丢弃队列中的 Bundle（§7）。
- 终态历史只保留 180 天；超期且完成备份生命周期后不可恢复（§5.10）。
- Replay 未实现（后续方向 V1.1）；结构化事件已为其预留（《区块6-10 v0.2》§6.12）。
- `ai_requests` 表 P1 才启用（《总规划》§6）。
- 不保存任何纯前端 UI 状态（《区块6-10 v0.2》§10.10）。

## 12. Design Notes（为什么）

- **为什么内存权威 + DB 记录**：单桌状态串行在内存最简单、最快、可测试（《区块6-10 v0.2》§7.13/§7.20）；DB 只承担"能重建/能分析/能定位"的持久记录（§10.10）。
- **为什么每次牌局 Action 不同步写库**：DB 是牌局持久化的可用性依赖，不是 Action 裁决的正确性依赖；同步写会把数据库故障放大为已开局牌桌故障（§8.12）。Room/身份/Tournament 建立是低频控制面操作，为避免创建无持久化身份，仍采用先提交后确认。
- **为什么"存完整、读投影"**：内部诊断需要完整信息（Burn 牌面用于复现，§8.11），用户可见性由投影保证（[01](./01-engine-spec.md) §14；[02](./02-protocol-spec.md) §9）——在存储侧保留真相、在读取侧强制边界。
- **为什么 Snapshot 每手而不是每 Action**：每手是崩溃恢复的天然检查点粒度（《总规划》§7.2）；运行期刷新/切网/后台恢复仍从内存最新状态投影，不需每 Action 落库。
- **为什么增加 `room_players`**：规划点名的 7 张表覆盖牌局记录，但无法单独表达 Lobby 成员、Host 外键、Room 级昵称唯一性和跨场稳定凭证。该表只补齐身份关系，不复制 Engine 状态域，也不持久化 Presence。

## 13. 工程裁决登记（无未决项）

| 原 TBD # | 裁决 | 理由与落点 |
| --- | --- | --- |
| 1 | 固定使用 Drizzle ORM + `pg`，migration 使用 Drizzle Kit | Supabase 是 PostgreSQL 托管/数据层，Drizzle 是 game-server 访问层，两者不冲突。`pg` 便于在同一连接上显式控制事务、行锁和复合 DDL；见 §3/§5.9。 |
| 7 | P1 单人模式必须创建 Room 记录，不延期到 P2 | 现有 `room_players`/Tournament/Commit Bundle 已覆盖身份、Bot、恢复与 AI 用量，新建第二套持久化路径反而工程量更大。`rooms.id` 对外即 `gameId`，`mode=SINGLE_PLAYER`、`invite_code=NULL`；见 §5.1。 |
| 13 | 统一业务历史 TTL 为终态后 180 天；中间 Snapshot 为 7 天；主库删除后的托管备份最多再保留 30 天 | 同时给用户历史/诊断留出窗口，并限制隐藏牌、匿名身份与 AI 用量的长期暴露面；见 §5.10。 |

其他已裁决事项：`playerToken` 使用 HMAC 摘要（§5.2）；引入 `room_players`（§5.2）；Event Sequence 以 Tournament 为作用域（§5.6）；筹码持久化使用 `bigint`；名次使用稳定打破并列（§5.4）；`hands.summary` 保留（§5.5）；P0 Hand History 读时投影（§6）；手末数据单事务原子提交（§7）；AI 原始 Prompt/Response 不落库（§5.8）。

## 14. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 数据访问层 | 《区块6-10 v0.2》§10.1：PostgreSQL + Drizzle（可替换，非核心决策） | 《总规划》§6：Supabase 数据层（Supabase Postgres） | 两者分层兼容：DB = Supabase Postgres，game-server 访问层 = Drizzle ORM + `pg`，migration = Drizzle Kit；见 §13 决策 1 |
| 2 | 退出后参赛者语义（持久化侧面） | 《区块1-5 v0.1》§4.8：退出后 Sitting Out，继续缴盲至自然淘汰 | 《总规划》§4.1：`EXIT_PENDING` → 安全结算点转 `WITHDRAWN` + `forfeitedChips` | 以《总规划》为准；已由 [01](./01-engine-spec.md) §21 冲突 1 / [02](./02-protocol-spec.md) §18 冲突 2 裁决，本文只落实字段 `forfeited_chips` |
| 3（澄清，非冲突） | Snapshot 写入节奏 | §7.19："每手结束后保存 Snapshot" | §8.12："Hand Events 与 Snapshot 可异步或按 Hand 批量持久化" | 兼容：前者定每手末节奏，后者定异步失败语义；首手尚无 Snapshot 时按 Tournament 配置/参赛者重新初始化 |

《总规划》v1.0 新增、docx 未覆盖的决策（本文已吸收）：Supabase Postgres 作为数据层（§6）；`ABANDONED_NO_HUMAN` 与 `CLOSED` 后邀请码立即失效（§4.2）；"已完成的 Hand History 与断开原因持久化保存"（§4.2）；每手结束保存 Snapshot（§7.2）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。

## 15. 实现验收门槛

> **状态（TEX-22，2026-08-25）**：项 1、2、3、7 已达成（TEX-18，真实 PostgreSQL 集成测试）；项 4（恢复）与项 5 的持久化写入/watermark 部分已由 TEX-22 达成——恢复与 Writer 行为经 Fake Persistence unit 测试覆盖（`apps/game-server/src/persistence/**/*.test.ts`），真实 PostgreSQL 恢复仓储经 `apps/game-server/tests/integration/recovery.test.ts` 覆盖（缺测试库时受控跳过）；项 5 的"soft 门控新 Tournament"与"hard 预留最坏情况空间后暂停"仅实现 Writer 侧 watermark 检测 + 手间边界 `PAUSE_AFTER_HAND` 机制。项 6（凭证）、8（投影字段级）、9（保留期清理）、10（单人模式）、11（文档同步）仍为后续任务。

本文不在“创建了表”时完成，而在以下条件全部满足后才能由“设计意图”改为“实现现状”：

1. Drizzle Schema 与受审查 SQL 能由 Drizzle Kit 产生/管理可版本化 migration；DDL migration 能在空库一次成功执行，并能用新 migration 向前修改；不以手工改生产库或未审查 schema push 代替迁移。
2. 所有 PK/FK/复合 FK/UNIQUE/CHECK/部分索引都有“合法行成功 + 越界行失败”的数据库集成测试，特别覆盖跨 Room Host、跨 Tournament Player/Hand、重复 Sequence/Seat/Rank 和枚举-null 矛盾。
3. 手末事务在每一个写入步骤注入失败后均不留部分数据；用原任务重试不产生重复行，同 ID/不同 `commit_checksum` 必须报错和告警。
4. 恢复测试至少覆盖：首手中崩溃时从已持久化配置/参赛者重新初始化，序列从 0 重新开始；多手后回到最新手末；最新 Snapshot checksum 损坏时向前退回；Schema/Engine 版本不受支持时拒绝猜测恢复。
5. DB 断开测试证明已开始的 Hand 可继续到安全结算，新 Room/加入/开局明确失败；soft watermark 能告警与拒绝新建/开局，hard watermark 能在预留最坏情况 Bundle 空间后于手间边界暂停，且未提交 Bundle 不丢失、不覆盖。
6. 凭证测试证明 token 由 CSPRNG 生成且具有至少 256-bit 随机熵，DB 只有 HMAC 摘要/密钥版本，错误 token 使用常数时间比较失败，Room 关闭或成员 `LEFT` 后旧 token 不可再建立连接，日志/错误中不含 token、digest、昵称或 AI 原文。另验证客户端丢失 token 后 P0 不存在昵称找回或服务端还原原 token 的路径。
7. 以 Supabase `anon` 和 `authenticated` 角色对每张原始表做读/写尝试均被拒绝；game-server 专用 Role 只具有运行所需的最小权限。
8. Hand History/Replay 投影的字段级测试证明未授权 Hole Cards、Burn Cards、Deck、token digest 与内部 AI 元数据永不到达客户端或 BotView。
9. 保留期清理在隔离数据集上验证：终态 7 天只清理中间 Snapshot，180 天按 §5.9/§5.10 顺序清理业务历史，主库删除后的备份不超过 30 天；全程不删除活跃 Tournament 恢复根、不留孤立外键记录。
10. P1 单人模式集成测试证明 `mode=SINGLE_PLAYER`、`invite_code=NULL`、`gameId=rooms.id`，一名 HUMAN Host 与 BOT 通过同一 `room_players`/`tournament_players`/Commit Bundle/Snapshot/AI Requests 链路运行，加入接口无法枚举或加入该 Room。
11. [02](./02-protocol-spec.md) 的 sequence/单人恢复语义、[04](./04-game-server-architecture.md) 的持久化队列/恢复流程与 [06](./06-testing-strategy.md) 的测试项已同步本文已裁决契约，不再保留“Snapshot 后回放未提交 Events”或“sequence 作用域未定”的旧表述。
