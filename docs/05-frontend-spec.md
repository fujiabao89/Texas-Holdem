# 05 · Web 前端工程规格（`apps/web`）

> 状态：设计定稿（TEX-23 前端基础、TEX-24 Lobby、TEX-21 WebSocket 认证/同步/重连、TEX-25 牌桌视觉与下注、TEX-26 动画/音效/重连体验已核对；赛果与历史待后续任务）
> 实现核对：2026-08-26（TEX-26）——`apps/web` 已在既有 `RoomSnapshot`/`GameSnapshot`/连续 Event Patch 与单一 Transport 上实现 AnimationQueue（连续 Event 后的 presentation、Snapshot 屏障、Soft/Hard catch-up、Reduced Motion 终帧）、本地 Kenney CC0 音效与开关、断线/接管/退出提示；操作、倒计时与命令仍只读 canonical projection。独立赛果页和历史仍为**设计意图**。
> 权威范围：本文是 Web 前端（`apps/web`）工程设计的唯一权威来源——页面与路由、客户端状态与投影消费（Snapshot + Event Stream）、横向 Seat 牌桌与响应式布局、下注交互（快捷下注 / Slider / ± 调整 / 精确输入 / All-in 两步 / Time Bank）、AnimationQueue 与事件动画、音效、计时与连接状态展示、重连 UX、错误码展示、Lobby 与房间流、淘汰观战 / 赛果 / Hand History UI、可访问性与验收标准。范围之外的事实见 [工程文档总索引](./README.md)：Engine 规则语义属 [01](./01-engine-spec.md)，wire 契约与 `PlayerView` 投影属 [02](./02-protocol-spec.md)，服务端执行与计时属 [04](./04-game-server-architecture.md)，持久化属 [03](./03-data-model.md)，AI 推理属 P1 `server/ai`。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§3.1/§5/§6/§7/§9/§10）；《德州扑克项目规划_区块1-5_v0.1.docx》§1.5/§2.8–2.10/§4/§5（仅在《总规划》未覆盖处补充）；《德州扑克项目规划_区块6-10_v0.2.docx》§6.6/§7.10/§8.2/§8.13/§9.16–9.18/§10.3/§10.11（仅在《总规划》未覆盖处补充）；规则语义与事件目录见 [01](./01-engine-spec.md)，wire 契约见 [02](./02-protocol-spec.md)，服务端执行见 [04](./04-game-server-architecture.md)
> 对应代码：`apps/web/`（TEX-23 已建立 `src/app` 路由壳、`messages/`、`protocol/` 与 `state/`；《总规划》§6 的 Next.js 16 + React 19 + TypeScript + Tailwind CSS 4、Jotai、Radix UI、Framer Motion 依赖已配置。Seat Layout、AnimationQueue 与业务 UI 待 TEX-24+）
> 上级索引：[工程文档总索引](./README.md)

> **【部分已实现】** TEX-23 已落地路由壳、投影与命令状态边界；TEX-24 已落地 §6.1–§6.4 的 Home/Create/Join/Lobby、授权 HTTP 控制面与 Lobby WS 投影消费；TEX-21 在同一 Transport 上落地 Token 恢复、认证、断线退避、权威 Room/Game 快照屏障、连续 Event/Clock 消费和旧会话停止。TEX-25 已落地 §7/§8 的基础牌桌、响应式 Seat、Board/Pot、服务端 LegalActions 操作区、普通下注金额控件、All-in 两步确认、Time Bank 和连接/命令反馈；HTTP 超时/取消、受限 sessionStorage 降级和按 `appliedSequence` 回收 pending 已测试。动画、音效、独立赛果页和历史仍待后续任务逐项回填。

## 1. Purpose

前端是四个核心技术资产之一——"Poker Interaction Layer：横向牌桌 + 快捷下注 + 动画 + Showdown"（《区块6-10 v0.2》§10.20）的载体，也是实施路线图第 5、6 步（《总规划》§10）。它的存在理由：

- 项目关键边界是"规则属于 Engine；唯一真实状态属于 Game Server；**客户端只能展示和提交请求**"（《总规划》§6）。前端把这条边界翻译成体验：渲染投影后的 `PlayerView`、消费已确定 Event、提交 Action 信封，绝不承担任何规则或状态权威。
- P0 发布门槛直接点名前端（《总规划》§9.1）：刷新、断网、网络切换与手机后台恢复可用；客户端不能读取隐藏信息；**手机常规下注无需键盘**；核心发牌/翻牌/Showdown 动画在桌面和手机上可接受。
- 体验是产品价值的一部分而非后期美化（《区块1-5 v0.1》§5.5/§5.15）：卡顿、动画时序错乱、下注步骤过多、手机端频繁弹键盘、Showdown 瞬间跳结果，都应视为真实产品缺陷。

## 2. Responsibilities / Non-Responsibilities

### 2.1 负责

| 职责 | 依据 |
| --- | --- |
| 页面与路由：Home / Create / Join / Lobby / Table / Result / Settings（P0），Single Player Setup（P1 预留） | 《区块1-5 v0.1》§5.2；《总规划》§5.1/§7.1 |
| 客户端状态管理与投影消费（Snapshot 初始化 + 带 `sequence` Event 应用） | 《总规划》§5.2/§5.3 |
| 动态 Seat 布局（2–10 人）与响应式（桌面横向、手机竖屏重新排布） | 《总规划》§7.1；《区块1-5 v0.1》§5.3/§5.13 |
| 下注交互：仅由服务端下发的 `LegalActions` 驱动；快捷下注、Slider、±、精确输入、All-in 两步、Time Bank 按钮 | [01](./01-engine-spec.md) §5.2；《区块1-5 v0.1》§5.7–5.9；《区块6-10 v0.2》§9.16 |
| 快捷下注金额的筹码舍入（UI 层职责；Engine 只接受最终合法整数金额） | [01](./01-engine-spec.md) §8.6；《区块6-10 v0.2》§9.16 |
| AnimationQueue：消费 Game Events 驱动视觉时序；积压时 Fast Forward | 《区块6-10 v0.2》§7.10/§10.3；《总规划》§7.2 |
| 音效与全局开关（含 Showdown 牌型语音） | 《区块1-5 v0.1》§5.12；《总规划》§7.2 |
| 计时展示（倒计时仅展示、`timeBankRemainingMs`）、连接状态与重连 UX | 《总规划》§3.1/§3.2；《区块1-5 v0.1》§5.10；《区块6-10 v0.2》§8.3 |
| 错误码处理与展示（`STALE_GAME_STATE` 重同步、`ACTION_TIMEOUT` 丢弃等） | [02](./02-protocol-spec.md) §11/§12 |
| 淘汰观战、赛果与用户版 Hand History UI | 《区块1-5 v0.1》§4.9/§5.11；[01](./01-engine-spec.md) §14 |
| 无障碍基础组件（Radix UI）与可访问性 | 《总规划》§6 |

### 2.2 不负责（及归属）

| 不负责 | 归属 | 依据 |
| --- | --- | --- |
| 规则计算、`LegalActions` 生成、金额合法性校验 | [01](./01-engine-spec.md) §5.1/§5.2（Engine）；客户端**不得**自行推断 | 《总规划》§6；《区块6-10 v0.2》§6.7 |
| 牌局状态权威与投影（`PlayerView`/`BotView`） | `apps/game-server` State Projector（[04](./04-game-server-architecture.md) §11） | 《总规划》§5.3 |
| 计时权威（`actionDeadline`/`timeBankRemainingMs` 维护与超时裁决） | `apps/game-server` Scheduler（[04](./04-game-server-architecture.md) §8） | 《总规划》§3.2 |
| Action 的幂等、sequence 校验与串行执行 | `apps/game-server` 串行执行器（[04](./04-game-server-architecture.md) §7） | 《总规划》§3.2 |
| 持久化（Hand History 存储、Snapshot 落盘） | [03](./03-data-model.md) | 《区块6-10 v0.2》§10.10 |
| AI 决策、AI 控件（P0 不显示） | P1 `server/ai` | 《总规划》§6/§8 |

## 3. Dependencies

| 依赖 | 类型 | 用途 | 失效影响 |
| --- | --- | --- | --- |
| `packages/protocol` | 类型与 Schema | Action/Event/Snapshot/ErrorCode/`TournamentConfig` 的共享类型，杜绝协议漂移 | 前后端类型断链 → 联调期才暴露协议错误（《区块6-10 v0.2》§10.4） |
| `apps/game-server`（HTTP + WS） | 运行时唯一数据源 | Snapshot/Event 下发、Action 提交、错误码 | 服务不可用 → 前端进入重连/错误态（§14） |
| Next.js 16 / React 19 / TypeScript / Tailwind CSS 4 | 实现工具 | 应用框架与样式 | — |
| Jotai | 实现工具 | 客户端 UI 状态（§5.1） | — |
| Radix UI | 实现工具 | 无障碍基础组件（Dialog、Slider、Toast 等） | — |
| Framer Motion | 实现工具 | 牌桌动效（transform/opacity） | — |
| 音效素材 | 静态资源 | §10 音效目录 | 素材缺授权 → 停用对应音效，不阻塞牌局（§10） |

反向约束：`apps/web` **不得依赖 `poker-engine` 运行时**——展示所需的全部规则产物（`bestFiveCards`、牌型、Pot 赢家）都由投影与事件负载提供（[01](./01-engine-spec.md) §10/§14；《总规划》§6）；不得引入 DeepSeek SDK 或任何 API Key（《区块6-10 v0.2》§8.5）；不得直连数据库（[03](./03-data-model.md) §9）。

## 4. 技术栈与总体结构

### 4.1 技术栈（《总规划》§6）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Next.js 16 + React 19 + TypeScript | 与 Wolfcha 同路线；本项目实时牌局无 SSR/SEO 诉求，牌桌页以客户端渲染为主【设计意图】 |
| 样式 | Tailwind CSS 4 | 普通页面与通用组件 |
| 客户端状态 | Jotai | 纯 UI 状态（§5.1）；牌局数据副本不是"组件状态"而是单向数据流 |
| 无障碍组件 | Radix UI | Dialog、Slider、Toast、Switch 等基础件 |
| 动效 | Framer Motion + 自建 AnimationQueue | 牌桌动效；队列归本文 §9 |

> 旧规划《区块6-10 v0.2》§10.1/§10.2 曾建议 Vite + React + Zustand；《总规划》§6 改为 Next.js 16 + React 19 + Jotai。裁决见 §21 冲突 1。

### 4.2 页面与路由【已裁决】

| 路由 | 页面 | 核心任务 | 阶段 |
| --- | --- | --- | --- |
| `/` | Home | 创建房间、加入房间（P0 首页仅这两个入口，§20 冲突 2） | P0 |
| `/create` | Create Room | 房主配置人数、筹码、盲注、行动时间、Time Bank；高级面板编辑 Blind Structure | P0 |
| `/join` | Join Room | 邀请码 + 昵称；邀请链接仅预填邀请码 | P0 |
| `/room/[roomId]` | Room Lobby | 座位、选座/随机入座、Ready、配置摘要、邀请码、房主权限、开始比赛 | P0 |
| `/room/[roomId]/table` | Poker Table | 完整牌局体验（§7/§8/§9/§11）；新 Tournament 沿用稳定房间 URL | P0 |
| `/room/[roomId]/result/[tournamentId]` | Game Result | 排名、冠军、"再来一局"、返回；保留具体 Tournament 身份 | P0 |
| `/settings` | Settings / Rules | 基础设置（音效开关等）与规则说明 | P0 |
| `/single` | Single Player Setup | 单人模式人数与比赛设置 | **P1**（P0 不显示入口） |

### 4.3 目录布局【已裁决】

```text
apps/web/
├─ app/                         # Next.js App Router；目录与 §4.2 URL 一一对应
│  ├─ page.tsx                  # Home
│  ├─ create/ · join/ · settings/ # P0 公共路由（扁平目录，不使用路由组）
│  └─ room/[roomId]/            # Lobby / Table / Result 页面壳与 Error Boundary
├─ features/
│  ├─ room/                     # 创建、加入、Lobby 与配置
│  ├─ table/                    # Table、Seat、Cards、Pot、ActionPanel
│  ├─ result/                   # 赛果
│  └─ hand-history/             # History 列表与详情
├─ components/ui/               # Radix 封装的通用无障碍组件
├─ protocol/                    # HTTP Client、WS Connection Manager、Schema 边界
├─ state/                       # 规范态、计时态、Jotai UI atoms 与 selectors
├─ animation/                   # AnimationQueue、presentation model、事件动画目录
├─ sound/                       # Sound registry、AudioContext 与已授权素材
├─ messages/zh-CN.ts            # P0 中文文案；所有用户可见字符串走 key
├─ public/audio/                # 本地托管的处理后音频，不运行时热链第三方
└─ tests/                       # 组件/前端集成测试；跨应用 E2E 位于仓库 tests/e2e/
```

路由只使用不敏感的 `roomId/tournamentId`；邀请码仅允许作为 `/join?code=XXXXXX` 的预填参数，`playerToken` 永不进入 URL。Feature 内部可以再分 `components/hooks/model`，但不得复制 `packages/protocol` 类型或另建第二套 WS Client。

## 5. 客户端状态与数据流

### 5.1 状态分层

| 层 | 内容 | 载体 | 写入路径 |
| --- | --- | --- | --- |
| 牌局规范态 | 当前 `PlayerView` 的客户端镜像：座位、筹码、底牌（仅本人）、公共牌、Pot、行动权、`LegalActions` | 独立 store（非组件状态）【设计意图】 | **唯一**：`GAME_SNAPSHOT` 覆盖 + 已通过 Schema 校验的连续 `GAME_EVENT` 应用（[02](./02-protocol-spec.md) §6） |
| 房间规范态 | 当前 `RoomSnapshot`：成员、座位、Ready、连接状态、房主与配置 | 独立 store | **唯一**：按 `roomRevision` 接受较新的 `ROOM_SNAPSHOT` |
| 计时展示态 | `currentActorPlayerId`、`actionDeadline`、`timeBankRemainingMs`、最近一次已接受消息的 `serverTime` | 独立轻量状态 | `GAME_SNAPSHOT` 初始化；匹配当前行动机会且较新的 `CLOCK_UPDATED` 更新（§5.2） |
| 动画展示态 | 当前屏幕正在展示的牌、筹码位移、Reveal/Highlight Overlay 与队列游标 | AnimationQueue 管理的 presentation model | 仅由已接受 Event 派生；不得作为提交 Action 或判断合法性的依据（§9） |
| 纯 UI 状态 | 下注金额草稿、待提交命令、面板开合、音效开关 | Jotai（《总规划》§6） | 仅组件交互与命令生命周期 |
| 派生展示模型 | Seat 旋转坐标、倒计时剩余、金额格式、按钮可见性 | 由以上状态派生 | 无独立写入 |

规则：

- 纯 UI 状态和动画展示态**绝不写回**牌局规范态；对牌局的一切意图只能通过 Client Command 信封提交。`SUBMIT_ACTION` 必须同时携带稳定的 `requestId`、`actionId` 与 `expectedSequence`（[02](./02-protocol-spec.md) §6.1/§7）。
- 操作按钮集合完全由服务端下发的 `LegalActions` 决定，客户端不自行推断（[01](./01-engine-spec.md) §2.1/§5.2；《区块6-10 v0.2》§6.7）。
- 服务端拒绝 Action 时状态不变，客户端不得本地补偿（[01](./01-engine-spec.md) §5.1；§14 错误处理）。

### 5.2 Event 消费

- 按 `sequence` 单调应用；缺失不猜测、请求重同步；重复丢弃（[02](./02-protocol-spec.md) §12）。
- 断线/重连：先取最新 Snapshot 覆盖副本，再消费新 Event；断线期间旧动画不重放（[02](./02-protocol-spec.md) §6/§10）。
- 积压严重：Fast Forward 到最新 Snapshot（§9.6；《总规划》§7.2）。
- 数据应用与动画播放解耦：Event 到达即更新数据副本，视觉由 AnimationQueue 另行走带（§9.3）——快进永远有正确终态可跳。
- `packages/protocol` 必须导出以 `event.type` 为判别字段的 `ProjectedGameEvent` 联合类型、每种 Payload 的运行时 Schema 与 `GameSnapshot` Schema；前端不得针对 `payload: object` 手写类型断言。Schema 不通过、未知 Event 或 reducer 无法穷尽处理时，不应用该消息并以 `INVALID_EVENT` 请求 Snapshot。
- reducer 必须是纯函数并对联合类型做穷尽检查，按 [02](./02-protocol-spec.md) §6.3/§9.2 应用 `PlayerViewPatch`；每个 Event 的测试至少断言 `apply(before, patch) == after`、重复 sequence 无副作用、缺序触发重同步。具体 wire 字段只在 02 / `packages/protocol` 定义，本文不复制第二套 Payload 契约。

`CLOCK_UPDATED` 是明确的旁路消息，不属于 Game Event，也不推进 `sequence`。客户端只在 `tournamentId`、`handId`、`currentActorPlayerId` 与当前牌局规范态一致，且消息信封 `serverTime` 不早于最近一次已接受的 Clock/Snapshot 时应用；否则丢弃。其 `timeBankRemainingMs` 始终是当前接收者的余额，即使行动者是其他玩家。它只允许修改计时展示态，不能修改筹码、行动权或 `LegalActions`。新的 `GAME_SNAPSHOT` 总是重置这条计时旁路的基线。

### 5.3 Transport Client 不变量

- HTTP 响应、WS Server Message、Snapshot、Patch、Event 和 Error 必须在网络边界通过 `packages/protocol` 的运行时 Schema 后才能进入 store；解析失败不得把部分数据写入状态，统一转为协议错误并按场景重同步或停止连接。
- P0 HTTP 路径完全采用 [02](./02-protocol-spec.md) §4.2 的 `/api/v1/...` 契约。所有改变状态的 HTTP `POST/PATCH` 必须携带 UUID `Idempotency-Key`；同一逻辑请求的网络重试复用相同 Key 与 Body，用户重新发起的意图使用新 Key。
- WS 由单一 Connection Manager 持有；组件不得各自建立 socket、保存 Token 或自行重试。建立后 5 秒内发送 `AUTHENTICATE`，认证完成前不发送其他命令；收到 `UNSUPPORTED_PROTOCOL_VERSION`、`AUTH_FAILED` 或 `SESSION_REPLACED` 时停止自动重试并进入对应终态 UX。
- 页面卸载、房间切换和新连接接管时，旧连接的 listener、timer 与未完成订阅必须显式清理。开发环境 React Strict Mode 的重复 mount/unmount 不得产生双连接、双命令或重复 AnimationQueue consumer。

## 6. 页面规格

### 6.1 Home

- P0 仅两个核心入口：**创建房间**、**加入房间**（《总规划》§5.1）；单人入口 P1 加入（§20 冲突 2）。
- 白色主体、极简、不赌场化（《区块1-5 v0.1》§5.1）。

### 6.2 Create Room

- 配置项（《总规划》§7.1；《区块1-5 v0.1》§2.8）：最大人数（2–10）、初始筹码、SB/BB、盲注模式（固定/按时间/按手数）、行动时间（有限时档位 / 不限时）、Time Bank（可关闭或总额预设）；高级面板编辑 Blind Structure（逐 Level，允许下降）。
- 最大人数默认 6。配置预设只负责填入表单，用户修改任一预设字段后标记为“自定义”；切换预设必须先确认是否覆盖未保存修改。

| 预设 | 初始筹码 | 初始盲注 | 升盲 | 行动时间 | Time Bank 总额 |
| --- | ---: | ---: | --- | ---: | ---: |
| 快速 | 5,000 | 50/100 | 每 3 分钟 | 20 秒 | 30 秒 |
| 标准（默认） | 10,000 | 50/100 | 每 5 分钟 | 30 秒 | 60 秒 |
| 深筹码 | 30,000 | 50/100 | 每 10 分钟 | 45 秒 | 120 秒 |
| 自定义 | 从“标准”复制后编辑 | — | 固定/按时间/按手数 | 自选 | 自选 |

- 三个内置升盲预设共用盲注序列：`50/100 → 75/150 → 100/200 → 150/300 → 200/400 → 300/600 → 400/800 → 600/1,200 → 800/1,600 → 1,000/2,000 → 1,500/3,000 → 2,000/4,000 → 3,000/6,000 → 5,000/10,000 → 7,500/15,000 → 10,000/20,000 → 15,000/30,000`；P0 内置预设不启用 Ante。最后一级保持不再上涨，避免有限配置耗尽。
- 行动时间档位固定为 `15/20/30/45/60 秒/不限时`，默认 30 秒；Time Bank 总额固定为 `关闭/30/60/120 秒`，默认 60 秒；每次成功使用最多延长 30 秒或剩余余额（取较小值），每个行动机会最多成功一次。不限时强制关闭并隐藏 Time Bank。P0 不提供 10 秒档，避免移动端和辅助技术用户因网络/操作成本遭受过度激进的默认体验。
- **前端预校验 + 服务端最终校验**：约束权威在 [01](./01-engine-spec.md) §2.1/§12（`SB < BB`、正整数、每 Level 独立校验）；前端校验只是体验优化，最终 Schema Validation 在服务端（《区块6-10 v0.2》§10.11）。
- 创建成功后展示生成的 6 位邀请码（《总规划》§5.1；字符集见 [02](./02-protocol-spec.md) §5）。

### 6.3 Join Room

- 输入：邀请码 + 昵称（2–16 字符，同房间不可重复）（《区块1-5 v0.1》§4.3；[02](./02-protocol-spec.md) §5）。
- 邀请链接仅预填邀请码，用户仍需输入昵称（《总规划》§5.1；《区块1-5 v0.1》§4.4）。
- 失败提示走稳定错误码映射（房间不存在 / Room Full / 昵称重复等，[02](./02-protocol-spec.md) §11）。

### 6.4 Room Lobby

- 展示：座位图（空位/真人，P1 加 AI）、Ready 状态、房间配置摘要、邀请码（可复制 + 邀请链接）。
- 操作：可选空 Seat 或随机入座；Ready/UNREADY；房主可改配置、踢人、开始（仅 Lobby）。
- 开局条件 UI（《总规划》§2.1）：至少 2 名真人 + 所有真人 Ready + 无未完成配置变更；开始按钮据此可用/禁用并展示原因。房主不能绕过自己的 Ready 强制开始。
- 开局后锁定：不显示配置、选座、踢人等控件（《总规划》§2.3）。
- 房主标识随转移更新（比赛前房主离开 → 转给最早加入且在线的真人，《总规划》§4.2）。

### 6.5 Poker Table

内容即 §7（布局）、§8（下注）、§9（动画）、§11（计时与连接状态）的合集，本节不重述。

### 6.6 Game Result

- 排名（并列展示顺序由服务端结果给定，UI 只展示；《总规划》§2.1）、冠军、各玩家最终筹码/名次。
- `FINISHED → LOBBY` 后提供"再来一局"（新建 Tournament，不复用旧牌局状态，《总规划》§5.1）与返回。
- 无真人关房（`CLOSED`/`ABANDONED_NO_HUMAN`）时展示房间已关闭（《总规划》§4.2）。

### 6.7 Settings / Rules

- 基础设置：全局音效开关（§10.2）；规则说明静态页（《区块1-5 v0.1》§5.2）。

### 6.8 P1 预留（P0 不实现、不显示）

- Single Player Setup（1 真人 + 1–9 AI）；Lobby 内 AI 座位添加/移除；AI 标识与"思考中…"状态（《总规划》§1/§8；《区块1-5 v0.1》§3.1/§4.6/§5.10）。`participant.kind = HUMAN | BOT` 从第一天建模，但 P0 不显示 AI 控件（《总规划》§6）。

### 6.9 界面语言与 i18n【已裁决】

- P0 唯一界面语言为简体中文，locale 固定 `zh-CN`；URL 不增加语言前缀，也不显示语言切换器。英文作为后续阶段加入，不阻塞 P0。
- 从第一天使用稳定文案 key：用户可见文本集中在 `messages/zh-CN.ts`，组件、ErrorCode 映射、Toast、无障碍名称和音效字幕不得硬编码中文。TypeScript 从主语言资源推导 key 联合类型，缺 key 在构建期失败。
- P0 不引入重量级运行时翻译服务；提供 `t(key, values)`、复数/变量插值和 `Intl.NumberFormat('zh-CN')` / `Intl.DateTimeFormat('zh-CN')` 封装。筹码完整值使用千分位，移动端空间不足时才用 `万` 缩写并在可访问名称/详情中保留完整值。
- 后续英文使用 `messages/en-US.ts`，与 `zh-CN` key 完全集合相等后再开放语言设置；扑克动作、牌型、花色、错误码和动态变量必须通过词条/格式化函数组合，禁止依赖中文语序拼接句子。

## 7. 牌桌布局与响应式

### 7.1 视觉定位（《区块1-5 v0.1》§5.1）

- 极简、明亮、白色主体；牌桌可使用深青绿色椭圆毛毡面与深色桌沿作为唯一强色块，页面留白、状态条与操作面板保持白色；**不赌场化**（无霓虹、金币、VIP、宝箱或高饱和装饰）。
- TEX-25 桌面视觉顺序固定为：顶部轻量状态条、中央椭圆牌桌（底池与公共牌居中、玩家环绕）、底部本人 Seat 与悬浮操作区。深青绿色仅表达牌桌实体，不能扩展为整页深色背景。

### 7.2 Seat Layout（《总规划》§7.1；《区块6-10 v0.2》§10.3）

- 2–10 人**动态** Seat 布局，不能写死固定数量组件（《区块1-5 v0.1》§5.3）。
- 桌面端牌桌横向展开，优先适配 16:9 / 16:10。
- 基于 Seat 坐标的 absolute positioning / transform，不依赖普通文档流（《区块6-10 v0.2》§10.3）。
- **自身 Seat 无论真实编号，视觉上始终位于屏幕下方偏中央；其他座位相对旋转**（《总规划》§7.1）。
- 根据实际入座人数将其余 Seat 均匀分布于顶部及左右；空 Seat 只保留无障碍语义，不以普通文档流占位破坏椭圆牌桌。
- Dealer Button、SB/BB 标识随每手位置移动（[01](./01-engine-spec.md) §11）。

### 7.3 信息层级（《区块1-5 v0.1》§5.4）

| 优先级 | 信息 |
| --- | --- |
| 最高 | 自己的 Hole Cards、Community Cards、Pot、当前行动、操作按钮 |
| 中 | 玩家筹码、当前下注、Dealer/SB/BB、盲注 Level、剩余玩家 |
| 低 | Hand History、设置、邀请码等辅助信息 |

### 7.4 玩家卡与状态标识

- 当前行动者清晰高亮 + 倒计时（§11.1）；Fold 后牌背/玩家卡降低视觉权重；All-in 明确显示 `ALL-IN`，不能与淘汰混淆；断线玩家显示 `Disconnected`（《区块1-5 v0.1》§5.10）。
- `WITHDRAWN`（主动离开/断线满 10 分钟）玩家按服务端推送的状态展示，不再发牌/行动（《总规划》§4.1；[01](./01-engine-spec.md) §13）。
- 连续多次 Auto Fold 的断线玩家可标记"暂离"（《区块6-10 v0.2》§8.2）。

### 7.5 响应式

- 手机竖屏**重新布局与压缩信息**，不是简单缩放桌面牌桌（《总规划》§7.1；《区块1-5 v0.1》§5.13）。
- 自己的 Hole Cards 与操作区域拥有最高布局优先级（《区块1-5 v0.1》§5.13）。
- 10 人桌移动端允许压缩玩家信息（昵称缩写/筹码简写），必要时点击玩家卡查看详情（《区块1-5 v0.1》§5.3/§5.13）。
- 实机验收尺寸（《区块6-10 v0.2》§9.18）：~390×844、~360×800 手机竖屏、平板、1366×768、1920×1080；10 人桌单独验收姓名、Stack、D/SB/BB、当前 Actor 与操作区不重叠。

### 7.6 可访问性（P0）

- 目标为 **WCAG 2.2 AA**；Radix UI 只提供基础语义，业务组合组件仍须自行验收键盘、焦点、名称、状态和对比度。
- 所有操作必须可用键盘完成并具有可见焦点；Dialog 打开时锁定焦点，关闭后返回触发元素；Slider 除方向键外提供可直接到达最小值/最大值的键盘操作，精确金额输入具有关联 Label 与错误说明。
- 不以颜色作为唯一状态表达：当前 Actor、Fold、All-in、Disconnected、赢家与错误状态同时提供文本或图形标识。移动端主要点击目标至少 `44×44 CSS px`。
- 扑克牌提供稳定的可访问名称（例如“黑桃 A”），牌背只读为“未公开牌”；动态 Pot、当前行动、错误和连接变化使用克制的 `aria-live`，不得逐帧播报倒计时或筹码动画。
- 尊重 `prefers-reduced-motion: reduce`：跳过发牌位移、翻转和筹码飞行动画，以淡入或立即呈现终态替代；事件顺序、Showdown 信息和停留可读性保持不变。减少动画不得影响 AnimationQueue 完成、Fast Forward 或任何数据状态。

## 8. 下注交互与操作区

### 8.1 按钮出现时机（《区块1-5 v0.1》§5.7）

- 只在**轮到自己行动**时展示 Fold/Check/Call/Bet/Raise/All-in；平时牌桌保持干净，轮到时操作区平滑出现，提交动作后收起。P0 无 Pre-action。

### 8.2 按钮集合与 `LegalActions` 映射（[01](./01-engine-spec.md) §5.2）

| 按钮 | 条件 | 显示 |
| --- | --- | --- |
| Fold | `canFold` | — |
| Check | `canCheck` | — |
| Call | `canCall` | 显示 `callAmount` |
| Bet | `canBet` | 进入金额面板，普通 Bet 范围 `[minBetTo, maxRaiseTo]` |
| Raise | `canRaise` | 进入金额面板，Slider 范围 `[minRaiseTo, maxRaiseTo]` |
| All-in | `canAllIn` | 显示 `allInTo`，两步操作（§8.5） |

- 客户端不自行推断合法性：条件完全取服务端下发的 `LegalActions` 与投影字段（《区块6-10 v0.2》§6.7）。
- `maxRaiseTo` 是普通完整 Bet/Raise 的提交上限；`allInTo` 是 All-in 的目标总投入。即使两者数值相同，选择 All-in 也必须提交 `{ type: "ALL_IN" }`，不得伪装成 `BET`/`RAISE`；Short Call/Short Raise All-in 可能低于普通 Slider 最小值，必须作为独立 All-in 端点展示（[01](./01-engine-spec.md) §5.2/§8.3/§8.4）。
- Slider 的连续区间只表示普通 `BET`/`RAISE` 合法区间；可以把 `allInTo` 显示为独立吸附节点，但到达该节点后最终按钮必须切换为 All-in 两步提交语义。`canBet`/`canRaise` 为假时不得仅因 `canAllIn` 为真构造普通下注区间。

### 8.3 快捷下注（《区块1-5 v0.1》§5.8；《总规划》§7.1）

| 阶段 | 快捷档位【已裁决】 |
| --- | --- |
| Pre-Flop | 2BB、2.5BB、3BB、4BB 等 BB 倍数 |
| Post-Flop | 1/3 Pot、1/2 Pot、2/3 Pot、Pot、All-in |

- Pre-Flop 固定展示 `2BB/2.5BB/3BB/4BB/All-in`，BB 倍数表示本街目标总投入：`rawTo = multiplier × 当前级别 bigBlind`，不是“再增加 multiplier BB”。Post-Flop 固定展示 `1/3 Pot/1/2 Pot/2/3 Pot/Pot/All-in`。
- 定义 `potBeforeAction = sum(PlayerView.pots[].amount)`。无人下注且 `canBet` 时，Pot 比例候选为 `rawBetTo = fraction × potBeforeAction`；面对下注且 `canRaise` 时，候选为 `rawRaiseTo = actor.streetBet + callAmount + fraction × (potBeforeAction + callAmount)`。后式先计入 Call，再以 Call 后 Pot 计算加注部分；不得把结果作为额外加注额提交。
- 普通候选按下述 step 四舍五入（恰好一半向上），再夹取到对应 `[minBetTo|minRaiseTo, maxRaiseTo]`。多个档位得到相同目标额时只保留一个；被夹到下限的首项显示“最小 {amount}”，到达 `allInTo` 的项统一转换为独立 All-in 确认态并提交 `ALL_IN`。
- 金额 step 固定为 `max(1, round(currentBigBlind / 10))` 个筹码；Slider 与 `±` 共用该 step，长按 `±` 在 400ms 后以每 100ms 一次连续变化。合法边界值即使不是 step 的整数倍也必须可精确到达；`callAmount`、`min*To`、`maxRaiseTo`、`allInTo` 永不自行舍入。
- Slider 拖动改变下注额，快捷档位产生轻微吸附；吸附不得阻止用户选择其他合法整数目标额。
- 精确输入：**点击金额数字后才打开数字键盘**；键盘不是默认方式（§1 Purpose 硬门槛）。输入过程中保留用户原值；非整数或越界时显示提示并禁用提交，不静默改值。仍聚焦的合法草稿点击提交时必须在同一次交互中作为提交金额，失焦不得吞掉该点击。失焦时可以将草稿夹取到当前普通 Bet/Raise 合法区间，并以可见文案告知调整结果。

### 8.4 键盘不是默认方式（《区块1-5 v0.1》§5.8）

常规下注必须"一键完成大部分操作"，手机端不能以数字键盘为常态；只有非常规精确金额（如 5648）才调出键盘。E2E 必须覆盖无需键盘完成 1/3 Pot、1/2 Pot、2/3 Pot、Pot、All-in、Slider、±（《区块6-10 v0.2》§9.16）。

### 8.5 All-in 两步（《区块1-5 v0.1》§5.9）

- **不弹确认 Modal**：点击 All-in 快捷项后进入确认态，显示服务端给出的目标总投入 `allInTo`（例如 `ALL-IN · TO 7200`）；用户再次点击才提交 `{ type: "ALL_IN" }`。若确认前 `sequence`、当前 Actor 或 `canAllIn/allInTo` 改变，或用户改选普通 Bet/Raise 模式或金额（包括尚未提交的精确金额草稿），立即取消确认态——天然两步确认且不复用陈旧金额。

### 8.6 Time Bank 按钮

- 有限时且 `timeBankRemainingMs > 0`，并且 viewer 是当前 actor 时：展示"使用延时"按钮，点击发送 `USE_TIME_BANK`（[02](./02-protocol-spec.md) §8.1）。
- **不限时模式 UI 不展示 Time Bank**（强制禁用，《总规划》§3.1）。
- 余额与截止时间以服务端字段为准（§11.1）。

### 8.7 提交与失败

- `SUBMIT_ACTION` 使用 Client Command 信封：外层 `requestId`，Payload 内含 `actionId`、`tournamentId`、`expectedSequence` 与 Action（[02](./02-protocol-spec.md) §6.1/§7.2）。同一逻辑提交的重试必须复用完全相同的 `requestId`、`actionId` 和 Payload；新决策才生成新 ID。
- 首次提交后进入 `SENDING`，锁定重复点击并保留待提交记录，操作区可收起但不得乐观修改牌局规范态。`COMMAND_RESULT(APPLIED)` 只把命令标记为 `APPLIED_AWAITING_STATE`；在 `GAME_EVENT.sequence >= appliedSequence` 或 Snapshot 覆盖该序号前仍不得重新开放同一行动机会。`COMMAND_RESULT(REJECTED)` 按错误码结束或等待重同步。任何 `COMMAND_RESULT` 都不直接推进牌局规范态。
- 连接中断且命令结果未知时，不生成新 ID 自动重复同一动作；重连完成并取得 Snapshot 后，若同一 `expectedSequence` 与行动机会仍有效，才允许用原 ID/原 Payload 重发，否则废弃 pending。用户在拒绝或状态推进后重新选择动作时使用新 ID。
- 拒绝处理见 §14：`STALE_GAME_STATE` 重同步后重新决策；`ACTION_TIMEOUT` 丢弃并等待状态。

> **实现核对（TEX-25）**：牌桌只以 `WebSocketTransport` 的命令订阅获得 pending/拒绝/重试反馈；在对应 Event/Snapshot 越过 `appliedSequence` 前保持禁用。`ProjectionStore` 仍是唯一的牌局状态源，乱序/重复/过期消息由其既有序列屏障处理。

> **实现核对（TEX-26）**：`ProjectionStore` 在连续 Patch 已原子写入 canonical 后才向 AnimationQueue 发出只读 `{ message, afterCanonical }`，并为 `GAME_SNAPSHOT`/`RECONNECT_RESULT` 发出清队列屏障。动画不写回投影、不发送 Action；Hard Fast Forward 仅经既有 Transport 请求权威 Snapshot。`PLAYER_REVEALED.handRank.bestFiveCards` 是服务端 evaluator 公开字段，Web 端不重算牌型或赢家；`BURN_CARD` 不含、也不会生成牌面。

## 9. AnimationQueue 与事件动画

### 9.1 定位

- 客户端用 **AnimationQueue** 控制视觉时序；动画由 Game Events 驱动，不允许 Engine sleep 或等待客户端（《区块6-10 v0.2》§6.6/§7.10）。
- 动画逻辑集中在队列与动画目录，不散落在大量 React 组件中（《区块6-10 v0.2》§10.3）。
- 优先使用 transform / opacity 等 GPU 友好属性，减少 Layout Thrashing 与整棵 React Tree 重渲染（《区块6-10 v0.2》§10.3）。

### 9.2 队列模型（设计意图）

- 输入：按 `sequence` 到达的已投影 Event（§5.2）。
- 每个事件映射为一个或多个动画任务，任务有标称时长；队列只影响视觉，不影响 §5 数据副本的更新时点。
- 动画播放不发起任何网络请求、不产生任何 Action；动画失败/超时直接跳过该任务（§14）。
- 接受 Event 时，将 Patch 应用到牌局规范态并冻结得到该序号的 `afterCanonical`；动画的 `beforePresentation` 必须取当前队尾的目标展示态（队列为空时才取当前屏幕展示态），不能取已经领先多步的规范态或正在播放的中间帧。随后把 `{ event, beforePresentation, afterCanonical }` 入队。牌桌过程读取动画展示态；操作按钮、计时与 Action Payload 始终读取最新规范态。
- 每个任务必须以幂等的 `commitFinalFrame()` 结束，将该任务涉及的展示字段对齐到 `afterCanonical`；取消、异常、Reduced Motion 和超时也必须走同一终态提交路径。

### 9.3 数据与动画解耦（关键设计意图）

Event 到达 → 数据副本立即应用（§5.2）→ 同一事件进入 AnimationQueue 播放视觉过程。由此保证：

- 动画积压或掉帧不影响数据正确性（《区块6-10 v0.2》§8.13）；
- "提前结算 2"（所有剩余玩家 All-in 后 Engine 立即完成剩余公共牌与结果）场景下，服务端一次下发全部事件，前端仍按动画队列逐步展示（[01](./01-engine-spec.md) §6）；
- Fast Forward 永远可以跳到最新数据终态，无需"补播"。

### 9.4 事件 → 动画目录

| 事件（目录权威 [01](./01-engine-spec.md) §14） | 视觉行为 | 依据 |
| --- | --- | --- |
| `HAND_STARTED` / `DEAL_HOLE_CARD` | 桌面始终呈现一个位于公共牌下方、边界不与 Board 交叠的可见 Deck；每个接收者都对同一已投影 Event 看见牌背从该 Deck 沿连续的上扬弧线飞向目标座位手牌区。每个 Event 必须启动独立动画实例，不得因复用已完成的 DOM/CSS animation 而跳过轨迹。自己的牌到位、停顿后才翻开，其他人始终保持牌背。飞行只使用合成层 `transform` / `opacity`，不得仅播放音效或用通用提示替代可见发牌 | 《区块1-5 v0.1》§5.5 |
| `BURN_CARD` | 牌背从 Deck 移出，进入 Muck/弃牌区或淡出；**永不翻面**（事件不携带牌面） | 《区块6-10 v0.2》§6.6；《总规划》§7.2 |
| `FLOP_DEALT` | 三张公共牌从 Deck 方向依次到达各自的目标牌框，再逐张 Flip；一条 Event 不得直接把三张正面牌替换进 Board | 《区块1-5 v0.1》§5.5 |
| `TURN_DEALT` / `RIVER_DEALT` | 单张牌背先进入对应目标框、停顿后 Flip 展示 | 同上 |
| `PLAYER_CHECKED` / `PLAYER_CALLED` / `PLAYER_BET` / `PLAYER_RAISED` / `PLAYER_FOLDED` / `PLAYER_ALL_IN` | 快速、克制的筹码位移或淡出反馈 | 同上 |
| `SHOWDOWN_STARTED` / `PLAYER_REVEALED` | 揭牌（仍有权争夺的玩家按规则公开底牌） | 《区块1-5 v0.1》§5.11 |
| `POT_AWARDED` | Pot 分配视觉反馈（筹码移动 + 获胜者突出） | 同上 |
| `PLAYER_ELIMINATED` / `TOURNAMENT_FINISHED` | 淘汰/终局展示，衔接 Game Result | [01](./01-engine-spec.md) §14 |

### 9.5 Showdown 剧本（《区块1-5 v0.1》§5.11；《区块6-10 v0.2》§9.17）

```text
揭牌（Reveal）→ 展示七张已公开候选牌 → 淡出服务端未选中的候选牌
→ 组合服务端 `bestFiveCards`（[01] §10）→ 牌型文字
→ 比较 → 突出获胜者与获胜金额 → Pot 分配视觉反馈
```

- `PLAYER_REVEALED.handRank.bestFiveCards` 是唯一的选牌事实：客户端只按 rank+suit 身份将已公开底牌和 Board 中的五张移入组合，不能用规则代码重算牌型、选择替代牌或判断赢家。两张底牌并不必然都入选，Board 的五张也可能全部入选。
- 先展示牌型、再突出赢家与金额、最后执行 Pot 分配；Side Pot 按各 Pot 独立展示获胜结果。
- Hand End 短暂停留让用户看清结果，再开始下一手（《区块1-5 v0.1》§5.6）。
- Showdown 是重点人工验收场景（《区块6-10 v0.2》§9.17）。

### 9.6 节奏与 Fast Forward

- 动画常量统一维护在 `animation/timings.ts`，组件不得散落魔法数字：

| 任务 | 时长/间隔 |
| --- | ---: |
| 单张手牌飞入 / 同轮座位间隔 / 自己翻牌 | 900ms / 300ms / 600ms |
| Blind/Call/Bet/Raise 筹码移动 | 220ms |
| Check / Fold / All-in 反馈 | 140ms / 200ms / 280ms |
| Burn 移出 | 160ms |
| Flop 单张入框并翻牌 / 张间隔 | 1,000ms / 300ms |
| Turn、River 入框并翻牌 | 1,000ms |
| Showdown 单人 Reveal / 人间隔 | 1,400ms / 120ms |
| Best Five 候选淡出与组合 / 牌型标签停留 | 5,000ms / 3,000ms |
| Winner 突出 / 每个 Pot 分配 | 800ms / 450ms |
| Hand End 最终停留 | 1,000ms |

- 单个普通动作视觉反馈不得超过 300ms；公共牌必须完整保留“入框、停顿、翻面”的可读节奏。Showdown 从首次 Reveal 到首个 Pot 开始分配以看清候选牌淡出和 Best Five 组合为优先，双人常规剧本目标不超过 15 秒；Side Pot 很多时保留信息顺序，但每个额外 Pot 的停留可缩短至 300ms。
- AnimationQueue 预计视觉落后超过 2 秒或待播任务超过 8 个时进入 Soft Catch-up：普通操作的纯展示反馈可提高到 1.75×或跳过，但 Deal/Burn/Board/Reveal/Winner/Pot 等语义帧保持声明时长，不能在 CSS 卡牌飞行/翻面完成前提交 canonical 终帧。预计落后超过 28 秒或未播 Event 超过 40 个时进入 Hard Fast Forward，发送 `REQUEST_SNAPSHOT(reason=MANUAL)`；阈值高于一手按可读节奏播放的双人 All-in 正常事件突发，因此完整的公开街牌、Reveal 与 Best Five 先在 Soft Catch-up 中播放，不能被 Hard Forward 直接跳过。
- 服务端对单连接满足任一条件即发送 `RESYNC_REQUIRED`：未发送 `GAME_EVENT ≥64`、最老未发送 Event 等待 `≥5s`、或应用队列估算字节数加 `ws.bufferedAmount ≥256KiB`；随后丢弃该连接旧积压并用 Snapshot 重建屏障。总待发送量达到 `1MiB`，或 30 秒内始终无法回落到 `256KiB` 以下时，以 Close Code `1013` 关闭并由客户端退避重连（[04](./04-game-server-architecture.md) §9.5）。
- Fast Forward 的原子操作顺序为：暂停取任务 → 清空队列与 Overlay → 应用新 Snapshot 到牌局规范态 → 将动画展示态整体对齐到该 Snapshot → 恢复接收屏障后的 Event。不得出现新规范态搭配旧牌面/筹码 Overlay 的混合帧。
- Soft Catch-up 不提示用户；Hard Fast Forward 使用 120ms 淡出/淡入，并在完成后显示 3 秒 Toast“牌局进度已同步至最新状态”。如果正在展示 Showdown，先保留最终 Board、赢家和各 Pot 结果的静态摘要至少 1 秒，再完成跳转。
- 慢动画/慢设备不能阻塞服务端、不能拖住整桌（[02](./02-protocol-spec.md) §16）。

## 10. 音效

### 10.1 目录（《区块1-5 v0.1》§5.12；《总规划》§7.2）

| 类别 | 音效 |
| --- | --- |
| 基础牌局 | 发牌、翻牌、Check、Bet/Raise、Fold、All-in、筹码入 Pot、Pot 获胜、轮到自己、盲注升级 |
| Showdown 牌型 | 对最终获胜牌型加入简短非语音提示音：Straight、Flush、Full House、Four of a Kind、Straight Flush；中文牌型名称始终以文字展示 |

### 10.2 控制

- 至少提供**全局音效开关**；细分开关（如牌型提示音）可后续加入（《区块1-5 v0.1》§5.12）。
- 浏览器自动播放策略：AudioContext 在首次用户交互后解锁；播放失败静默降级，不影响牌局【设计意图】。
- P0 基础牌局素材固定采用 [Kenney Casino Audio](https://kenney.nl/assets/casino-audio)，按钮/提醒缺口采用 [Kenney UI Audio](https://kenney.nl/assets/ui-audio)；两套资产页面均标示 Creative Commons CC0，[Kenney 官方授权说明](https://kenney.nl/support)确认资产可商用且无需署名（2026-08-21 核验）。Wolfcha 素材不纳入（《区块6-10 v0.2》§6.1）。同一短音效必须复用预加载的本地 voice pool，连续发牌不得为每个 Event 新建并解码音频元素；一条 Flop Event 可以按其三张牌实际到位、翻开的节奏发出三个本地 cue，Turn/River 也在落牌时播放，而不在权威 Event 刚入队时抢先发声。
- 素材必须下载后随应用本地托管，禁止运行时热链第三方。引入时在 `public/audio/THIRD_PARTY_NOTICES.md` 记录资产名、原始 URL、下载日期、原始文件名、采用文件、SHA-256 与许可证副本路径；即使 CC0 无强制署名，Settings / Credits 仍显示“Audio assets: Kenney”。
- 允许裁剪、响度归一化和格式转换，但不得叠加来源不明的采样。交付 `mp3` 主格式，并保留原始授权包与 License 文件；单个短音效目标小于 100 KiB，首屏不预载全部素材，轮到自己/All-in/Showdown 等关键音效在进入牌桌后空闲预取。
- P0 不依赖浏览器 TTS 或远程语音服务；牌型使用可区分但克制的非语音短音，并始终有同步中文文字。未来增加真人/合成语音时须重新记录来源、生成条款与商业使用权。

## 11. 计时、连接状态与重连 UX

### 11.1 计时展示（权威在服务端）

- `actionDeadline` 与 `timeBankRemainingMs` 由 server 更新并出现在 Snapshot/`CLOCK_UPDATED`（[02](./02-protocol-spec.md) §8.2/§9.2）；客户端倒计时**仅展示**（《总规划》§3.2）。
- 当前行动者高亮 + 倒计时（《区块1-5 v0.1》§5.10）。
- **本地倒计时归零不触发任何自动动作或状态变更**：Auto Check/Auto Fold 由服务端 Scheduler 以 `SYSTEM_TIMER` 源 Action 产生（《总规划》§3.1），前端等待事件。
- 每次接受带 `serverTime` 的服务端消息时记录锚点 `{ serverTimeAtReceipt, performanceNowAtReceipt }`；展示用 `estimatedServerNow = serverTimeAtReceipt + (performance.now() - performanceNowAtReceipt)`，剩余时间为 `max(0, actionDeadline - estimatedServerNow)`。新锚点不得让同一行动机会的倒计时回跳变长；只有接受到更大的 `actionDeadline`（例如合法使用 Time Bank）才允许增加显示。页面从后台恢复后立即使用最新锚点重算并触发重连/同步检查。
- 该估算包含单向网络延迟，只服务于 UX；归零不发送 Action、不判定超时，最终裁决仍由服务端单调时钟完成。

### 11.2 连接状态

- 断线（WS 关闭）只改 `ConnectionStatus`，扑克状态不变（[02](./02-protocol-spec.md) §10）：断线玩家保留 Seat、筹码与本手已投入筹码，UI 显示 `Disconnected`（《区块1-5 v0.1》§5.10）。
- 刷新、Wi-Fi/蜂窝切换、手机后台恢复**同一重连流程**：先视为断线而非离开（《总规划》§4.1；[02](./02-protocol-spec.md) §10）。

### 11.3 重连 UX

- 自身断线：非阻断式横幅/遮罩提示"重连中" + 自动重试；重连成功用**简洁 Toast**（《区块1-5 v0.1》§5.10）。
- 自动重试采用带 ±20% jitter 的指数退避：约 `0s → 0.5s → 1s → 2s → 4s → 8s → 10s`，之后以 10 秒为上限持续；任一时刻只允许一个连接尝试。浏览器触发 `online` 或页面重新变为 `visible` 时可以立即尝试一次并重置退避，但不得与已有尝试并发。
- 重连首帧 = 最新 Snapshot；断线期间旧动画不重放，直接从新 Event 开始（[02](./02-protocol-spec.md) §6）；期间发生什么可通过 Hand History 查看。
- 多设备接管：旧连接收到 `SESSION_REPLACED` 或 Close Code `4001` 后停止自动重连和所有命令发送并冻结最后合法视图，显示阻断 Dialog：标题“此牌局已在其他设备打开”，正文“当前页面已失去操作权限。你可以返回首页，或在此设备重新接管；重新接管会让另一设备失去操作权限。”按钮为主按钮“返回首页”和次按钮“在此设备重新接管”。只有用户明确点击重新接管才建立新连接，禁止自动争抢控制权；协议行为见 [02](./02-protocol-spec.md) §10。
- 自身断线横幅固定显示：“连接中断，正在重连。若持续断线满 10 分钟，你将退出比赛。”可以从本地检测断线时刻显示“约 09:59”倒计时，但必须标注“约”，且不得据此触发退出。剩余不足 2 分钟时横幅升级为警告色并触发一次 `aria-live` 通知，不重复播报秒数。
- 服务端投影进入 `EXIT_PENDING` 后显示持久提示：“退出处理中：本手将先安全结算，之后你会退出比赛。”转为 `WITHDRAWN` 后显示：“你已退出比赛，本场剩余筹码已按规则处理。”其他玩家卡只显示“已断线”或“已退出”，不展示精确宽限倒计时。

## 12. Lobby 与房间流（UX 视角）

| 流 | 前端步骤 | 依据 |
| --- | --- | --- |
| 创建 | Home → 配置（§6.2）→ 创建成功 → 展示邀请码 → Lobby | 《总规划》§5.1 |
| 加入 | Home → 邀请码+昵称 → Lobby（选空 Seat 或随机入座） | 《区块1-5 v0.1》§4.3/§4.6 |
| Ready | Lobby 内 READY/UNREADY；全员 Ready 是开局条件之一 | 《总规划》§2.1 |
| 开局 | 开始按钮可用条件（§6.4）→ `IN_GAME` → 进入 Poker Table；之后配置/座位控件全部锁定 | 《总规划》§2.3 |
| 房主 | 仅 Lobby：改配置、踢人、开始；开局后只是普通参赛者 | 《总规划》§7.1 |
| 离开 | 主动离开走确认流程；断线 ≠ 离开（§11.2） | 《总规划》§4.1 |
| 终局 | Game Result → "再来一局"（新 Tournament）或返回 | 《总规划》§5.1 |

- 邀请链接仅预填邀请码，不携带身份凭证（[02](./02-protocol-spec.md) §5）；`playerToken` 绝不进入 URL 或日志（[02](./02-protocol-spec.md) §11）。

## 13. 淘汰观战、赛果与 Hand History

- **淘汰观战**：被淘汰者角色变为 `ELIMINATED_SPECTATOR`，只读公开牌局状态与最终排名（《总规划》§5.3；《区块1-5 v0.1》§4.9），可继续观看或退出；UI 不显示任何操作区。P0 无外部自由观战。
- **赛果**：§6.6。
- **Hand History（用户版）**：桌面端使用右侧 Drawer（宽 360–420px），移动端使用全屏 Sheet；从牌桌页的“牌局记录”入口打开，打开/关闭不改变牌局状态或动画队列。
- 顶层按 `handNumber` 倒序分页，每页 20 手；列表项展示手号、结束时间、盲注、最终公共牌、总 Pot、赢家和结束原因。通过 `GET /api/v1/tournaments/{tournamentId}/hands?cursor&limit=20` 获取；滚动到底加载下一页，保留当前选中项和滚动位置。
- 点击一手进入按 `Pre-Flop / Flop / Turn / River / Showdown / Result` 分组的时间线，展示座位、公开动作、动作后目标投入、公共牌、已合法公开的底牌/牌型、各 Pot 与赢家；不展示原始 JSON、sequence、内部 ID、Burn 牌面或任何未公开底牌。详情通过 `GET /api/v1/tournaments/{tournamentId}/hands/{handId}` 获取。
- 当前未结束 Hand 不进入持久化历史列表；可以在 Drawer 顶部显示“本手进行中”并只读渲染客户端已接收的合法 Event，标记“暂存，结算后归档”。重连后以服务端列表为准，丢弃本地暂存历史。
- 列表与详情均由服务端按当前 `playerToken` 投影；原始事件永不直投客户端。加载失败保留牌桌并提供局部重试，不用全局 Error Boundary 替代。

## 14. Failure Handling

| 失败场景 | 检测方式 | 处理 | 用户可见结果 |
| --- | --- | --- | --- |
| WS 断开 | socket close（含 [04](./04-game-server-architecture.md) §9.6 的 15/45 秒心跳判定） | 显示断线状态 + 自动重连（§11.3）；不视为离开 | 横幅/遮罩"重连中"，牌局数据冻结展示 |
| 重连失败 | 重试超时 | 继续重试 + 提示可刷新 | 持续提示 |
| Event 缺失/重复 | `sequence` 检查 | 缺失 → 请求重同步取 Snapshot；重复 → 丢弃 | 短暂加载态后恢复最新状态 |
| 事件积压/掉帧 | 队列深度/滞后时长 | Fast Forward 到最新 Snapshot（§9.6） | 直接跳最新牌桌状态 |
| Action 被拒 `STALE_GAME_STATE` | 错误码 | 应用服务端下发的最新 Snapshot，重新决策 | 提示状态已更新 |
| Action 被拒 `ACTION_TIMEOUT` | 错误码 | 丢弃本地下注草稿，等待服务端状态事件 | 提示行动已超时 |
| 其他错误码（邀请码无效/昵称重复/Room Full 等） | [02](./02-protocol-spec.md) §11.2 稳定错误码 | 映射为 §14.1 中文文案 | 按 §14.2 选择内联/Toast/横幅/阻断态 |
| 多设备接管（旧连接失权） | `SESSION_REPLACED` / Close Code `4001` | 停止重连与发送、冻结最后合法视图 | "已在其他设备接管" + 返回入口 |
| 本地倒计时偏差 | 与 `actionDeadline` 比对 | 以服务端字段校准（§11.1） | 修正显示 |
| 动画任务异常/超时 | AnimationQueue 任务失败 | 跳过该任务，数据不受影响（§9.2） | 无视觉阻塞 |
| 音效播放失败 | 加载/播放错误 | 静默降级（§10.2） | 无感 |
| React 渲染异常 | Error Boundary | 局部降级 + 重试，不白屏；牌局数据副本不受影响【设计意图】 | 局部错误 UI |

### 14.1 ErrorCode → 中文文案【已裁决】

客户端只按稳定 `code` 分支，不直接向用户展示服务端 `message`。花括号内容来自协议允许的安全 `details`；字段缺失时省略整段动态内容。

| ErrorCode | 用户文案 | 展示/动作 |
| --- | --- | --- |
| `INVALID_MESSAGE` | 客户端请求格式错误，请刷新页面后重试。 | 阻断提示；刷新 |
| `UNSUPPORTED_PROTOCOL_VERSION` | 当前页面版本过旧，请刷新后继续。 | 阻断提示；刷新；停止重连 |
| `AUTH_REQUIRED` / `AUTH_FAILED` | 身份凭证已失效，请重新加入房间。 | 阻断提示；清 Token；前往加入页 |
| `FORBIDDEN` | 你没有执行此操作的权限。 | 就近内联或 Toast；不重试 |
| `SESSION_REPLACED` | 此牌局已在其他设备打开。 | §11.3 阻断 Dialog |
| `RATE_LIMITED` | 操作过于频繁，请在 {seconds} 秒后重试。 | 持久横幅/按钮倒计时；按 `retryAfterMs` 解锁 |
| `ROOM_NOT_FOUND` | 未找到该房间，请检查邀请码。 | 加入表单内联 |
| `INVALID_INVITE_CODE` | 邀请码格式不正确。 | 加入表单内联并聚焦邀请码 |
| `INVITE_EXPIRED` | 邀请码已失效，请向房主获取新邀请。 | 加入表单内联；清预填码 |
| `ROOM_FULL` | 房间已满，暂时无法加入。 | 加入表单内联 |
| `NICKNAME_INVALID` | 昵称需为 2–16 个字符。 | 昵称字段内联并聚焦 |
| `NICKNAME_TAKEN` | 该昵称已被使用，请换一个。 | 昵称字段内联并聚焦 |
| `ROOM_LOCKED` | 牌局已经开始，当前不能修改房间设置。 | Toast；刷新 Room Snapshot |
| `NOT_HOST` | 只有房主可以执行此操作。 | Toast；刷新 Room Snapshot |
| `PLAYER_NOT_SEATED` | 请先选择座位。 | Lobby 内联；聚焦座位区 |
| `STALE_ROOM_STATE` | 房间信息已更新，请重新确认操作。 | Toast；接受最新 Room Snapshot |
| `TOURNAMENT_NOT_ACTIVE` | 当前没有进行中的比赛。 | 返回 Lobby/Result |
| `NOT_YOUR_TURN` | 当前还没轮到你行动。 | Toast；同步最新状态 |
| `INVALID_ACTION` | 该操作已不可用，牌局状态已更新。 | Toast；同步最新状态 |
| `INVALID_AMOUNT` | 下注金额不合法，请按最新范围重新选择。 | 操作区内联；如有安全 details 显示最新范围 |
| `ACTION_TIMEOUT` | 操作超时，系统已自动处理。 | Toast；清下注草稿并等待状态 |
| `STALE_GAME_STATE` | 牌局状态已更新，请重新选择操作。 | Toast；接受随后 Snapshot |
| `IDEMPOTENCY_KEY_REUSE` | 请求状态异常，已重新同步，请再试一次。 | 清 pending；同步；新意图使用新 ID |
| `TIME_BANK_DISABLED` | 本场未启用延时。 | 操作区内联；隐藏按钮 |
| `TIME_BANK_EMPTY` | 延时时间已用完。 | 操作区内联；隐藏按钮 |
| `TIME_BANK_NOT_AVAILABLE` | 当前不能使用延时。 | 操作区内联；刷新计时态 |
| `GAME_UNAVAILABLE` | 牌桌正在恢复，请稍后重试。 | 持久横幅；按 `retryable` 重试 |
| `INTERNAL_ERROR` | 服务暂时异常，请稍后重试。 | 错误区域；显示可复制“问题编号 {traceId}” |

未知 ErrorCode 统一显示“发生未知错误，请刷新后重试。”并记录安全遥测；不得猜测其可重试性。开发环境可以在 Console 输出经脱敏的结构化错误，生产环境只上报 `code/traceId/route/protocolVersion` 等白名单字段。

### 14.2 提示载体与节流【已裁决】

- **字段内联**：用户能在原处修复的输入错误，如邀请码、昵称、配置、下注金额；错误文本与控件以 `aria-describedby` 关联。
- **Toast**：无需阻断、无需长期记忆的结果。默认 3 秒；“已复制邀请码”2 秒，“重连成功”“牌局进度已同步至最新状态”3 秒，错误类 5 秒。相同 `code + context` 在 2 秒内去重，同时最多显示 3 条。
- **持久横幅**：断线/重连、Rate Limit、`GAME_UNAVAILABLE`、即将退出等持续状态；状态解除前不自动消失。横幅不得遮挡自己的底牌和操作区。
- **阻断 Dialog / 状态页**：协议版本不支持、身份失效、多设备接管、房间关闭及无法局部恢复的渲染错误；必须提供明确主操作，不只显示“知道了”。
- 成功/普通状态使用 `aria-live=polite`；会导致操作丢失的错误可使用一次 `assertive`。倒计时、动画帧和重复重连失败不得持续播报。所有提示使用 §6.9 的文案 key，不在组件内硬编码中文。

## 15. Invariants（前端层）

| 不变量 | 表述 | 依据 |
| --- | --- | --- |
| 单向数据 | 牌局规范态仅由 Snapshot 覆盖或按序应用 Event 的 `PlayerViewPatch` 更新；任何 UI 交互不直接修改它 | 《总规划》§6；[02](./02-protocol-spec.md) §6 |
| 投影只消费 | 只渲染协议投影字段；不构造未投影信息，不以 CSS 隐藏替代投影 | 《总规划》§5.3/红线 2 |
| LegalActions 权威 | 操作按钮集合完全由服务端下发的 `LegalActions` 决定 | [01](./01-engine-spec.md) §2.1/§5.2 |
| 计时仅展示 | 本地倒计时归零不触发任何自动动作或状态变更 | 《总规划》§3.2 |
| 序列消费 | 事件按 `sequence` 单调消费；缺失/乱序重取 Snapshot，不猜测 | [02](./02-protocol-spec.md) §14 |
| 动画不改数据 | 数据应用不依赖动画播放进度；快进/跳帧不影响数据正确性 | 《总规划》§7.2；《区块6-10 v0.2》§8.13 |
| 命令关联 | 重试同一逻辑命令复用原幂等标识；`COMMAND_RESULT` 不代替 Event/Snapshot 更新规范态 | [02](./02-protocol-spec.md) §6.1/§7 |

校验位置：投影只消费与 LegalActions 权威由 [02](./02-protocol-spec.md) §14 字段级测试与《区块6-10 v0.2》§9.13 覆盖（客户端侧断言"收到的 Payload 无未授权字段"，测试组织见 [06](./06-testing-strategy.md) §7）；下注无键盘、动画时序与响应式由 §16 验收覆盖（E2E 与人工验收组织见 06 §9）。

## 16. 验收标准（前端侧）

来源：《总规划》§9.1/§9.2；《区块6-10 v0.2》§9.16–9.18。

| 项 | 标准 |
| --- | --- |
| 下注无键盘 | 手机和桌面端绝大多数常规下注无需键盘；1/3 Pot、1/2 Pot、2/3 Pot、Pot、All-in、Slider、± 覆盖 E2E（《区块6-10 v0.2》§9.16） |
| All-in 两步 | 仅 `canAllIn` 时出现；第一次选择 `allInTo`，第二次确认并提交 `ALL_IN`。普通 Raise Slider 范围严格为 `[minRaiseTo, maxRaiseTo]`；Short All-in 作为独立端点，不伪装成 Raise |
| 配置与快捷金额 | 四个配置预设快照测试；全部行动/Time Bank 档位 Schema 测试；Bet 与 facing-bet Raise 对 1/3、1/2、2/3、Pot 的公式、舍入、夹取、去重及边界值表驱动测试 |
| 命令幂等 | 双击只产生一个逻辑命令；结果未知的重发复用同一 `requestId/actionId/Payload`；状态已推进后不重放旧动作；`APPLIED` 后持续锁定至对应 sequence 可见，`COMMAND_RESULT` 不直接修改牌局规范态 |
| 事件与计时 | Event reducer 穷尽类型；重复 Event 无副作用、缺序/非法 Payload 触发 Snapshot；乱序或已过期的 `CLOCK_UPDATED` 不覆盖当前行动机会，倒计时归零不产生 Action |
| 动画 | Deal 两轮发牌顺滑、Seat 时序正确；Burn 牌背移出不露牌面；Flop/Turn/River 翻牌顺序与 Event 一致；Showdown 按 Reveal → Best Five → 牌型 → Winner → Pot 剧本（《区块6-10 v0.2》§9.17） |
| 响应式 | ~390×844、~360×800、平板、1366×768、1920×1080；10 人桌姓名/Stack/D/SB/BB/当前 Actor/操作区不重叠（《区块6-10 v0.2》§9.18） |
| 重连 | 刷新、断网、网络切换、移动端后台恢复可用（《总规划》§9.1） |
| Fast Forward | Soft/Hard 阈值可用 Fake Clock 触发；Hard 路径无规范态/旧 Overlay 混合帧；`RESYNC_REQUIRED` 与 Close `1013` 均可恢复 |
| 接管与宽限 | 接管后不自动争抢、显式按钮可返回或重新接管；10 分钟约倒计时不触发本地退出；`EXIT_PENDING/WITHDRAWN` 文案与服务端状态一致 |
| Hand History | 20 条倒序游标分页、列表到详情、移动端/桌面布局、重连后服务端覆盖本地暂存；任何视图不出现未授权 Hole/Burn/Internal 字段 |
| 音效授权 | 所有生产音频均存在本地文件、来源 URL、许可证副本、SHA-256 和 Notices 记录；断网时无第三方音频请求 |
| 中文与文案 | P0 页面无裸露英文占位或组件硬编码用户文案；`zh-CN` key 类型检查通过；ErrorCode、Toast、横幅与 Dialog 快照覆盖完整码表 |
| 信息隔离 | 客户端不能读取隐藏信息（服务端投影测试为主，客户端侧断言配合，[02](./02-protocol-spec.md) §14） |
| 可访问性 | WCAG 2.2 AA；仅键盘完成创建/加入/Ready/下注/离开主流程；焦点顺序与 Dialog 返回正确；状态不只靠颜色；Reduced Motion 下功能、顺序和终态不变 |
| 分级 | 主流程不可用/重连失败/下注额错误 = P1 阻断发布；非核心 UI 偏移/轻微掉帧 = P2 排期修复（《总规划》§9.2） |

E2E 固定使用 **Playwright**，可访问性自动扫描使用 **axe-core**；跨应用旅程位于仓库 `tests/e2e/`，前端组件/集成测试留在 `apps/web/tests/`。浏览器矩阵、证据留存、CI 分层与门禁的权威在 [06-testing-strategy.md](./06-testing-strategy.md) §2/§9/§11（《区块6-10 v0.2》§9.20）。

## 17. Security Considerations

- **不承担权威**：前端不实现任何规则、权限或计时权威；信任边界在服务端（[02](./02-protocol-spec.md) §13）。
- **只消费投影**：客户端代码不得构造、缓存或请求任何未投影信息；严禁"先发送再用 CSS 隐藏"（《总规划》红线 2）。
- **XSS**：昵称等玩家输入渲染时转义（React 默认转义 + 服务端校验兜底，《区块6-10 v0.2》§8.8）；不使用 `dangerouslySetInnerHTML` 渲染任何玩家可控字符串【设计意图】。
- **凭证**：`playerToken` 仅保存在当前 Tab 的内存与 `sessionStorage`，按 `roomId` 隔离；不得写入 `localStorage`、IndexedDB、URL、日志、Analytics、错误上报或可持久化的状态快照。刷新可恢复同一匿名身份；Tab/浏览器会话关闭后不保证找回（符合 [02](./02-protocol-spec.md) §5 的 P0 无找回语义）。收到 `AUTH_FAILED`/`INVITE_EXPIRED`、房间 `CLOSED`，或主动离开成功后清除对应 Token。DeepSeek API Key 永不进入前端（《区块6-10 v0.2》§8.5）。
- **依赖服务端防线**：邀请码枚举与 Action 刷由服务端 Rate Limit 防御（[02](./02-protocol-spec.md) §13）；前端无需也不得自行实现"防作弊"逻辑。
- **生产部署**：CSP 等安全响应头属部署配置【设计意图】，与 Wolfcha 路线一致的 Supabase 托管假设见 [03](./03-data-model.md) §9。

## 18. Known Limitations

- TEX-24 不包含 TEX-25 的牌桌、下注、LegalActions 推断、动画、音效、赛果或 Hand History；Lobby 的权威实时接入及共享 HTTP 响应 Schema 见 [ADR-0001](./adr/0001-tex-24-lobby-transport-contract-prerequisite.md)。
- P0 无单人模式与 AI 控件；`participant.kind = HUMAN | BOT` 建模但不显示（《总规划》§1/§6）。
- 无 Pre-action（复杂预操作留待后续，《区块1-5 v0.1》§5.7）。
- 无聊天、表情/Sticker、复杂 3D/粒子特效/筹码物理、赌场化装饰、AI 思考过程展示（《区块1-5 v0.1》§5.14）。
- 断线期间旧动画不重放（[02](./02-protocol-spec.md) §15）。
- 无外部自由观战；仅本场淘汰者观战且只读（[02](./02-protocol-spec.md) §15）。
- Hand History 使用 HTTP 分页列表 + 详情，并按桌面 Drawer / 移动端全屏 Sheet 呈现（§13）。
- 移动端 10 人桌信息压缩，细节需点击展开（《区块1-5 v0.1》§5.13）。

## 19. Design Notes（为什么）

- **为什么自己的 Seat 固定在下方中央**：无论真实座位号，视觉上第一时间定位自己与自己的底牌，其他座位相对旋转（《总规划》§7.1）。
- **为什么快捷下注是默认路径**：手机端键盘是最大操作摩擦；"一键完成大部分操作"是 P0 硬门槛（《区块1-5 v0.1》§5.8；《总规划》§9.1）。
- **为什么 All-in 两步且不弹 Modal**：Modal 打断牌桌节奏；两步提交天然防误触（《区块1-5 v0.1》§5.9）。
- **为什么操作按钮只在轮到自己时出现**：平时牌桌保持干净，降低误操作与视觉噪音（《区块1-5 v0.1》§5.7）。
- **为什么 AnimationQueue 独立于组件**：时序集中可测；动画不散落组件；快进/跳帧只在一处实现（《区块6-10 v0.2》§7.10/§10.3）。
- **为什么数据应用与动画解耦**：慢动画/慢设备不能拖住整桌，Fast Forward 必须永远有正确终态可跳（《总规划》§7.2；《区块6-10 v0.2》§8.13）。
- **为什么只消费投影、不推断 LegalActions**：唯一权威原则——任何客户端推断都会与服务端裁决分叉（《总规划》§6；《区块6-10 v0.2》§6.7）。
- **为什么倒计时仅展示**：客户端时钟不可信，超时竞争裁决点在服务端（《总规划》§3.2）。
- **为什么 Next.js + Jotai 而非 Vite + Zustand**：跟随《总规划》§6 的 Wolfcha 同路线决策（§20 冲突 1）。
- **为什么断线不重放旧动画**：恢复即时性优先，旧内容走 Hand History（[02](./02-protocol-spec.md) §16）。

## 20. 裁决记录（原 TBD）

截至 2026-08-21，本文原 18 项 TBD 已全部裁决，无开放 TBD。后续若实现证据推翻某项，必须新增编号、说明证据、影响范围与批准人，不得静默改写既有裁决。

| 原编号 | 裁决 | 落点 |
| --- | --- | --- |
| 1 | 固定 Room 范围路由与 feature-first 目录 | §4.2/§4.3 |
| 2 | 完整 ErrorCode 中文文案与动作映射 | §14.1 |
| 3 | 动画常量、Showdown 上限与 Reduced Motion | §7.6/§9.6 |
| 4 | 快速/标准/深筹码/自定义预设，标准为默认 | §6.2 |
| 5 | 行动 `15/20/30/45/60/不限时`；Time Bank `关/30/60/120`，单次最多 30 秒且每次行动最多成功一次 | §6.2/§8.6 |
| 6 | 固定快捷档位及 Bet/Raise 的 `*To` 公式 | §8.3 |
| 7 | step=`max(1, round(BB/10))`，半数向上、边界精确可达 | §8.3 |
| 8 | 2s/8 任务 Soft Catch-up（仅普通反馈加速）；28s/40 Event Hard Fast Forward；服务端 64 Event/5s/256KiB，硬上限 1MiB/30s | §9.6 |
| 9 | Kenney Casino Audio + UI Audio（CC0），本地托管并留授权证据 | §10 |
| 10 | `serverTime + performance.now()` 展示锚点 | §11.1 |
| 11 | Playwright + axe-core；跨应用 E2E 位于 `tests/e2e/` | §16；[06](./06-testing-strategy.md) §2/§9 |
| 12 | 多设备接管采用冻结视图 + 明确手动重新接管 Dialog | §11.3 |
| 13 | 前端展示 10 分钟宽限提示、约计时及 `EXIT_PENDING/WITHDRAWN` 文案 | §11.3 |
| 14 | History 列表/详情；桌面 Drawer、移动端全屏 Sheet | §13 |
| 15 | Tab 级 `sessionStorage`，定义清理时机 | §17 |
| 16 | WCAG 2.2 AA | §7.6/§16 |
| 17 | 内联/Toast/横幅/阻断态的场景、时长、去重及 aria-live | §14.2 |
| 18 | P0 `zh-CN`；从第一天使用类型安全文案 key，英文后续加入 | §6.9 |

## 21. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 前端技术栈 | 《区块6-10 v0.2》§10.1/§10.2：React + TypeScript + Vite、Tailwind、Zustand、Motion/Framer Motion | 《总规划》§6：Next.js 16 + React 19 + Tailwind CSS 4、Jotai、Radix UI、Framer Motion | 以《总规划》为准（与 [02](./02-protocol-spec.md) §18 冲突 1 / [04](./04-game-server-architecture.md) §21 冲突 1 同族，本文落实前端侧面） |
| 2 | Home 页面入口 | 《区块1-5 v0.1》§5.2：Home 含单人游戏/创建房间/加入房间 | 《总规划》§5.1：P0 首页只有两个核心入口（创建/加入）；单人模式 P1 | 以《总规划》为准：P0 两入口，单人入口 P1 加入 |
| 3 | 断线/退出后的展示语义 | 《区块1-5 v0.1》§4.8：退出后 Sitting Out，继续缴盲自动 Fold 至自然淘汰（无强制淘汰） | 《总规划》§4.1：断线满 10 分钟或主动离开 → `EXIT_PENDING` → `WITHDRAWN` + `forfeitedChips` | 以《总规划》为准（与 [01](./01-engine-spec.md) §21 冲突 1 同族；前端落实 `Disconnected`/`WITHDRAWN` 状态展示） |
| 4 | Time Bank 消耗展示 | 《区块6-10 v0.2》§7.15：按 20/30 秒一段消耗 | 《总规划》§3.1：一次延长固定时段或剩余余额中较小者 | 以《总规划》为准（与 [01](./01-engine-spec.md) §21 冲突 3 同族；前端只展示余额与按钮，不呈现"分段"语义） |

《总规划》v1.0 新增、docx 未覆盖的决策（本文已吸收）：不限时模式强制禁用 Time Bank 且 UI 不展示（§3.1）；P0 开局条件 ≥2 真人（§2.1）；邀请链接仅预填邀请码（§5.1）；P0 不显示 AI 控件（§6）；"再来一局"新建 Tournament（§5.1）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。
