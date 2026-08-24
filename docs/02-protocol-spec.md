# 02 · 联机协议规格（`packages/protocol`）

> 状态：P0 协议契约已实现（TEX-17）；WebSocket 运行时、HTTP handler 与客户端消费仍待后续任务实现
> 实现核对：2026-08-24（TEX-17）——`packages/protocol` 已提供严格运行时 Schema、Schema 推导类型、消息/错误信封及纯 PlayerView/BotView 投影；本规格中的运行时编排条款仍为设计意图
> 权威范围：本文是客户端与服务器之间联机协议的唯一权威来源——HTTP/WebSocket 通道分工、身份与凭证、消息信封与 `Snapshot + Event Stream`、`sequence` 与幂等（`actionId`/`expectedSequence`/`receivedAt`）、超时竞争裁决、消息目录、`PlayerView`/`BotView` 投影契约、ErrorCode 码表。范围之外的事实（Engine 规则语义、Game Events 目录、串行队列与 Timer 实现、持久化模型、AI 推理、UI）见 [工程文档总索引](./README.md)。
> 依据：《德州扑克项目总规划.md》v1.0（2026-08-20，§3/§4/§5/§6/§8/§9）；《德州扑克项目规划_区块6-10_v0.2.docx》§7/§8/§10.4/§10.8（仅在《总规划》未覆盖处补充）；《德州扑克项目规划_区块1-5_v0.1.docx》§1.5/§3.8/§4；规则语义与事件目录见 [01-engine-spec.md](./01-engine-spec.md)
> 对应代码：`packages/protocol/`（TEX-17 已实现 Action/Event/Snapshot/ErrorCode 与 Schema；使用方 `apps/web`、`apps/game-server`、P1 `server/ai` 尚待接入）
> 上级索引：[工程文档总索引](./README.md)

> **【实现边界】** TEX-17 已实现本文的 Schema、推导类型、消息/错误信封和纯投影契约；其中运行时编排（认证、串行队列、计时、HTTP handler、WebSocket 发送与客户端状态机）仍待后续任务按本文接入。决策登记与剩余产品参数见 §17。

## 1. Purpose

联机协议是四个核心技术资产之一——"Multiplayer State System：Snapshot + Event + Reconnect"（《区块6-10 v0.2》§10.20）。它的存在理由：

- 项目的关键边界是"规则属于 Engine；唯一真实状态属于 Server；客户端只能展示和提交请求"（《总规划》§6）。协议是这条边界的**执行载体**：没有定义清楚的 wire contract，客户端就无法可靠地"只展示"、服务端就无法可靠地"再校验"。
- 前后端共享 Action/Event/Config/Error Code/Player View 类型，把协议漂移消灭在编译期而不是联调期（《区块6-10 v0.2》§10.4）。
- P0 发布门槛直接点名协议：刷新、断网、网络切换、后台恢复可用；重复 `actionId`、缺失 sequence、旧状态 Action、多设备接管有明确行为（《总规划》§9.1）。

## 2. Responsibilities / Non-Responsibilities

### 2.1 负责

| 职责 | 依据 |
| --- | --- |
| 定义 Client → Server 与 Server → Client 的 wire Schema（规划点名：`JoinRoom`、`Ready`、`Raise`、`UseTimeBank`、`RoomSnapshot`、`GameSnapshot`、`GameEvent`、`ReconnectResult`、`Error`） | 《区块6-10 v0.2》§10.8 |
| 消息信封与 `sequence` 语义、幂等字段（`actionId`/`expectedSequence`） | 《总规划》§3.2/§5.2 |
| ErrorCode 码表的唯一权威（Engine 只返回规则拒绝原因，wire 码由本文冻结） | 《总规划》§3.2；《区块6-10 v0.2》§8.8 |
| `PlayerView`/`BotView` 投影类型的字段级契约 | 《总规划》§5.3；《区块6-10 v0.2》§7.9 |
| "所有外部输入先 Schema Validate 再进入业务层"的入口规范 | 《区块6-10 v0.2》§10.8/§8.8 |
| HTTP 与 WebSocket 的通道分工 | 《总规划》§5.2；《区块6-10 v0.2》§7.2 |

### 2.2 不负责（及归属）

| 不负责 | 归属 | 依据 |
| --- | --- | --- |
| Action 合法性与规则语义（金额、回合、Raise 权） | [01](./01-engine-spec.md) §5.1/§8 | 《总规划》附录 B 红线 4 |
| Game Events 目录与事件产生顺序 | [01](./01-engine-spec.md) §14（本文只规定信封与传输） | 《区块6-10 v0.2》§6.12 |
| 单桌串行队列、Scheduler、Timer 的实现 | `apps/game-server`（[04](./04-game-server-architecture.md)） | 《总规划》§3.2/§6 |
| 持久化模型（Room/Tournament/Hand History/Snapshot 表） | [03](./03-data-model.md) | 《区块6-10 v0.2》§10.10 |
| 客户端动画与时序播放（AnimationQueue） | `apps/web` | 《区块6-10 v0.2》§7.10 |
| AI 推理、Schema 校验失败后的 Fallback | `server/ai`（P1） | 《总规划》§8 |

## 3. Dependencies

| 依赖 | 类型 | 用途 | 失效影响 |
| --- | --- | --- | --- |
| `poker-engine` 的 `Action`/`Event`/`TournamentConfig` 类型 | 类型引用（仅单向） | 协议 Schema 描述 Engine 语义对象 | Engine 自身**不得**依赖协议（无 UI/网络/DB，§10.6）；协议与 Engine 类型断链会制造非法 wire 类型 |
| Zod 或同类 Schema Validation | 实现工具 | 所有外部输入先校验再进业务层 | 缺 Schema → 非法输入直达业务层 |
| `apps/game-server`（运行时） | 被依赖 | 实现串行队列、投影、Timer、持久化 | 协议只是类型与契约；没有 server 实现则无运行时 |
| `apps/web` / P1 `server/ai` | 被依赖 | 消费 Snapshot/Event、提交 Action | AI 与真人复用同一动作 Payload（§7.2/§16） |

数据流（本文范围以 `│协议边界│` 标注）：

```text
首次进入/重连:  Client ─(身份凭证)─▶│协议边界│▶ Snapshot(PlayerView) ─▶ Client
                之后: Server ─Event[sequence]─▶ Client（消费后本地应用）

行动:           Client ─Action(actionId, expectedSequence)─▶│协议边界│
                ─▶ Server 记录 receivedAt ─▶ 该桌串行队列 ─▶ Engine 校验
                ─▶ GameState' + Events ─▶ 逐接收者投影 ─▶ Event 推送/拒绝+错误码
```

## 4. 通道与生命周期（HTTP vs WebSocket）

### 4.1 Wire 基础约定【规范性决定】

- P0 协议版本为 `1`。HTTP 路径统一放在 `/api/v1`；WebSocket 首条认证消息携带 `protocolVersion: 1`。不支持的主版本返回 `UNSUPPORTED_PROTOCOL_VERSION`，不得尝试“尽力解析”。
- 传输格式为 UTF-8 JSON；字段名使用 `lowerCamelCase`，`type`/`code` 等枚举值使用 `UPPER_SNAKE_CASE`。
- ID 是不透明字符串；客户端不得从 ID 格式推断业务含义。客户端生成的 `requestId`/`actionId` 必须是 UUID v4 或具备等价碰撞强度的值。
- `sequence` 是无符号 64 位整数，但在 JSON 中编码为十进制字符串（如 `"42"`），避免 JavaScript `number` 精度损失。客户端应用时使用 `BigInt` 或十进制整数库比较。
- `serverTime`、`actionDeadline` 等 wire 时间均为 UTC Unix epoch 毫秒整数。服务端内部仍以单调时钟裁决；wire 时间只用于展示，客户端不得据此决定动作是否有效。
- 筹码、下注额均为 `0..Number.MAX_SAFE_INTEGER` 范围内的整数；禁止浮点数、负数、`NaN`/`Infinity` 和数字字符串。
- 未声明字段默认拒绝（Schema `strict`）；可选字段缺失与显式 `null` 的语义必须由字段定义明确，不得互换解释。

规范关键词“必须/不得/应该/可以”分别对应 MUST/MUST NOT/SHOULD/MAY；示例中的省略号不属于合法 JSON。

### 4.2 通道分工与 HTTP 端点【规范性决定】

| 通道 | 职责 | P0 接口 |
| --- | --- | --- |
| HTTP | 低频命令与查询 | `POST /api/v1/rooms`、`POST /api/v1/rooms/join`、`PATCH /api/v1/rooms/{roomId}`、`POST /api/v1/rooms/{roomId}/tournaments`、`POST /api/v1/rooms/{roomId}/leave`、`GET /api/v1/tournaments/{tournamentId}/hands`、`GET /api/v1/tournaments/{tournamentId}/hands/{handId}` |
| WebSocket | 认证后的 Lobby/牌局实时命令、事件与重同步 | `GET /api/v1/ws`（生产环境只允许 `wss:`） |

- `POST /rooms` 创建房间并加入创建者；`POST /rooms/join` 以邀请码加入。两者均返回 `roomId`、`playerId`、`playerToken` 和当前 `RoomSnapshot`。
- 受保护 HTTP 接口使用 `Authorization: Bearer <playerToken>`；不得把 `playerToken` 放在 URL、查询参数或日志中。
- 所有会改变状态的 HTTP `POST/PATCH` 都必须携带 `Idempotency-Key: <uuid>`。同一身份、端点和 Key 的同 Payload 重试返回原结果；Key 相同而 Payload 不同返回 `IDEMPOTENCY_KEY_REUSE`。
- HTTP 成功响应为 `{ "data": ... }`；失败响应为 §11 的 `ErrorEnvelope`，HTTP 状态码只表达传输类别，调用方必须以稳定 `error.code` 分支。
- `LEAVE_ROOM` 以 HTTP 为权威入口；WS 的 `LEAVE_ROOM` 命令保留给已连接客户端，二者必须进入同一服务端命令处理路径并具有相同行为。

HTTP 请求最小结构：创建房间为 `{ displayName, config: TournamentConfig }`；加入为 `{ inviteCode, displayName }`；`PATCH /rooms/{roomId}` 为 `{ expectedRoomRevision, operation }`，其中 `operation` 是 `{ type: "UPDATE_CONFIG", config } | { type: "KICK_PLAYER", targetPlayerId } | { type: "CHANGE_SEAT", seat }`，`seat` 为合法座位号或 `null`（离座）。前两种仅房主可用，`CHANGE_SEAT` 只移动当前身份。`POST /rooms/{roomId}/tournaments` 为 `{ expectedRoomRevision }`，仅房主且满足开局条件时创建新 Tournament。

Hand History 列表使用 `GET /tournaments/{tournamentId}/hands?cursor=<opaque>&limit=20`；`limit` 默认 20、范围 1–50，按 `handNumber DESC` 稳定分页，响应 `{ tournamentId, items, nextCursor }`。`items[]` 至少为 `{ handId, handNumber, startedAt, endedAt, smallBlind, bigBlind, communityCards, endReason, potTotal, winnerPlayerIds }`，只包含已经手末原子提交的 Hand。详情响应为 `{ tournamentId, handId, startSequence, endSequence, events }`，其中 `events` 使用与请求者权限一致的 §6.3 投影，绝不返回内部完整事件。列表与详情均要求该 Tournament 所属 Room 的有效 `playerToken`。

### 4.3 WebSocket 建立与认证【规范性决定】

1. TCP/TLS 升级后，客户端必须在 5 秒内发送首帧 `AUTHENTICATE`：

   ```json
   {
     "type": "AUTHENTICATE",
     "protocolVersion": 1,
     "requestId": "uuid",
     "payload": { "roomId": "opaque-id", "playerToken": "secret" }
   }
   ```

2. 认证完成前，服务端不接受其他消息、不订阅房间广播；非法首帧返回错误后关闭连接。认证帧及 Token 必须从访问日志、结构化日志和追踪 Payload 中剔除。
3. 认证成功后的第一条业务消息必须是 `RECONNECT_RESULT`（首次连接也使用该类型），其中包含当前完整 Snapshot。服务端须按 §6.4 建立 Snapshot/Event 原子交接点。
4. `connection → player → seat` 映射由服务端维护；客户端命令不得携带 `playerId` 或 `seat` 来指定操作者。
5. 服务端每 15 秒发送 WebSocket Ping；连续 45 秒未收到 Pong 或任何有效入站帧即终止连接并标记断线。浏览器自动 Pong，不另定义应用层 `PING/PONG` 消息。

## 5. 身份与凭证

| 项 | 规定 | 依据 |
| --- | --- | --- |
| 身份三元组 | 无账号版本用 `playerId + 高熵 playerToken + roomId` 识别玩家；服务端实际以 Token 查出 `playerId`，不信任客户端自报身份 | 《总规划》§5.2 |
| 单人模式恢复 | `gameId + playerToken` | 《区块1-5 v0.1》§3.8 |
| 昵称 | 必须为 Unicode NFC 规范化、去除首尾空白后的 2–16 个 Unicode code point；同房间以 Unicode 默认大小写折叠后的结果判重，展示仍保留用户大小写；仅展示用途，**不是**安全身份凭证 | 《区块1-5 v0.1》§1.5/§4.3 |
| 邀请码 | 6 位、排除 0/O、1/I/L 等易混淆字符；是 **Room Locator**，不充当身份凭证；邀请链接仅预填邀请码 | 《总规划》§5.1；《区块1-5 v0.1》§4.2 |
| 刷新语义 | 刷新视为短暂断线 + 重连，**不能**重新创建同名玩家 | 《区块6-10 v0.2》§8.3 |
| 开局后 Host | 只是普通参赛玩家：不能改筹码、看隐藏牌或控制 AI | 《区块6-10 v0.2》§7.6 |
| 凭证保护 | `playerToken` 永不进入日志；DeepSeek API Key 永不进入前端、WebSocket 或日志 | 《区块6-10 v0.2》§8.11/§8.5 |

`playerToken` 由加入/创建房间的 HTTP 响应签发，至少包含 256 bit 密码学随机熵；服务端仅保存不可逆摘要。P0 Token 的权限范围限定为单个 `roomId + playerId`，房间关闭后失效。客户端丢失 Token 视为无法恢复该匿名身份；P0 不提供昵称找回身份。

## 6. 消息信封与 Snapshot + Event Stream

**同步模型**（《总规划》§5.2；《区块6-10 v0.2》§7.8）：

1. 进入/重连先获得合法的 **Player Snapshot**（已按接收者投影），之后消费带 `sequence` 的 Event。
2. 客户端发现 Event Sequence **缺失**时，不继续猜状态，而是请求重新同步；漏序、积压或过期状态直接重取 Snapshot。
3. 断线期间发生的**旧动画不重放**：客户端直接恢复最新牌桌状态，再从新的 Event 开始播放；期间发生了什么可通过 Hand History 查看。
4. 事件积压严重时允许 **Fast Forward** 到最新 Snapshot（《总规划》§7.2；《区块6-10 v0.2》§8.13）。
5. 每手结束持久化 Snapshot，作为进程崩溃恢复检查点（《总规划》§7.2；《区块6-10 v0.2》§7.19）。

运行期重连 Snapshot 从当前内存权威状态即时投影；“每手末持久化 Snapshot”只用于进程崩溃恢复检查点，不是普通刷新/重连的数据源。

### 6.1 Client Command 信封【规范性决定】

```ts
type ClientCommand<TType extends string, TPayload> = {
  type: TType;
  requestId: string;
  payload: TPayload;
};
```

- 每个逻辑客户端命令都必须有唯一 `requestId`，用于关联 `COMMAND_RESULT`；重发同一个命令时必须复用该 `requestId` 和完全相同的 Payload。
- `SUBMIT_ACTION` 还必须携带稳定的 `actionId`；重试同一扑克动作时必须同时复用 `requestId` 与 `actionId`，不能重新生成。
- `receivedAt` 是服务端入口元数据，**不是 wire 字段**，客户端传入同名字段必须被 Schema 拒绝。

### 6.2 Server Message 信封【规范性决定】

```ts
type ServerMessage<TType extends string, TPayload> = {
  type: TType;
  protocolVersion: 1;
  serverTime: number;
  payload: TPayload;
};
```

所有服务端业务消息均符合该信封。只有 `GAME_EVENT` 携带事件 `sequence`；Snapshot 的顶层 Payload 携带其覆盖到的 `sequence`。Lobby 变化使用独立的 `roomRevision`，不得混入 Tournament 事件序列。

### 6.3 Game Event 信封【规范性决定】

```ts
type GameEventMessage = ServerMessage<"GAME_EVENT", {
  tournamentId: string;
  sequence: string;
  handId: string | null;
  event: { type: GameEventType; payload: object };
  patch: PlayerViewPatch;
}>;
```

Game Event 的业务产生条件与规则语义以 [01 §14](./01-engine-spec.md#14-game-events区块6-10-v02-612) 为准；协议层负责 envelope、wire Payload、顺序、`PlayerViewPatch` 和逐接收者投影。客户端按 sequence 将 `patch` 应用到当前 PlayerView，得到该事件后的权威视图；`event` 用于动画、历史和语义展示。每个授权订阅者都会观察到连续的 sequence：私有发牌事件对非目标接收者仍保留同一 `type/sequence`，但删除 `card` 等私有字段，且其 patch 不得含私有牌。

### 6.4 Snapshot/Event 原子交接【规范性决定】

服务端生成 Snapshot 时必须在该 Tournament 串行执行器内建立屏障：

1. 捕获当前状态以及最后已应用事件序号 `S`；
2. 为该连接投影 Snapshot，并在发送期间缓冲该连接的 `S+1` 及之后事件；
3. 先发送含 `sequence: S` 的 Snapshot，再按序发送缓冲事件；
4. Snapshot 不得声称覆盖尚未反映到其状态中的事件。

客户端应用规则：

- 收到 Snapshot 后原子替换本地权威视图，并把 `lastSequence` 设为 Snapshot.sequence；清空旧动画队列。
- 收到 `sequence == lastSequence + 1` 的事件才应用；`sequence <= lastSequence` 视为重复并忽略。
- 收到 `sequence > lastSequence + 1`、事件无法按 Schema 解析，或 Tournament ID 不一致时，立即暂停事件应用并发送 `REQUEST_SNAPSHOT`；不得跳号或猜测状态。
- 重同步期间可以继续渲染最后一份合法视图，但必须禁用提交扑克 Action；收到新 Snapshot 后恢复。

## 7. 顺序、幂等与冲突裁决

权威机制：**服务端单桌串行执行器 + 单调时钟**，绝不由客户端倒计时决定（《总规划》§3.2）。裁决点是服务端接收与串行化顺序，与网络快慢无关，因此边界情况可重放、可测试。

### 7.1 sequence 作用域【规范性决定】

- 字段定名统一为 `expectedSequence`；不再使用 `expectedGameVersion`。
- `sequence` 作用域是一个 `tournamentId`：从 `"1"` 开始严格递增，跨 Hand 不重置；创建新的 Tournament 时重新从 `"1"` 开始。Lobby 使用 `roomRevision`。
- 一次状态转移可产生多个连续事件。当前 sequence 等于最后一个已提交事件的序号；尚无事件时为 `"0"`。
- 任何影响 Action 合法性或 Engine 扑克状态的已提交变化必须产生至少一个 Game Event，确保 `expectedSequence` 能检测陈旧视图。纯连接状态使用 `ROOM_SNAPSHOT`，纯计时延长使用 `CLOCK_UPDATED`，不推进 Game Event sequence。
- `SUBMIT_ACTION.expectedSequence` 必须与执行该 Action 前的当前 sequence **完全相等**。较小、较大或来自其他 Tournament 的值均拒绝为 `STALE_GAME_STATE`，随后发送最新 Snapshot。

### 7.2 Action 信封与金额【规范性决定】

```ts
type SubmitActionPayload = {
  tournamentId: string;
  actionId: string;
  expectedSequence: string;
  action:
    | { type: "FOLD" }
    | { type: "CHECK" }
    | { type: "CALL" }
    | { type: "BET"; betTo: number }
    | { type: "RAISE"; raiseTo: number }
    | { type: "ALL_IN" };
};
```

`betTo`/`raiseTo` 表示本街道目标总投入；其他动作不得附带金额。所有金额强制为整数筹码单位，具体合法性由 Engine 再校验。Payload 不包含 actor、seat、`receivedAt` 或客户端时间戳。

### 7.3 幂等语义【规范性决定】

- `requestId` 是所有 WS 变更命令的幂等键，作用域为 `roomId + playerId`；`actionId` 是扑克动作的额外业务幂等键，作用域为 `tournamentId + playerId`。服务端至少在 Room/Tournament 驻留内存期间保存原始 Payload 摘要与最终结果。
- 执行顺序必须先查幂等缓存，再检查 `expectedSequence`，这样一个已经成功但回执丢失的 Action 重试会得到原结果，而不是被新 sequence 错判为陈旧。
- 首次提交执行完成后，服务端返回最终 `COMMAND_RESULT`。相同 `actionId`、相同业务 Payload 的重试不得再次执行，必须返回 `duplicate: true` 且复用原结果。
- 相同 `actionId` 携带不同 Payload 返回 `IDEMPOTENCY_KEY_REUSE`；状态不变。
- 相同 `requestId` 携带不同消息类型或 Payload 同样返回 `IDEMPOTENCY_KEY_REUSE`；非 Action 命令的相同重试返回原 `COMMAND_RESULT`。
- `COMMAND_RESULT` 只是命令回执；客户端的牌局状态仍以 Snapshot/Event 为唯一来源，不得根据回执自行模拟状态转移。

### 7.4 超时竞争裁决【规范性决定；修正旧文冲突】

1. Action 被 WS 入口完整解析并通过基础 Schema 后，服务端立即以单调时钟记录不可伪造的 `receivedAt` 和入口序号，再投递到 Tournament 串行执行器。
2. 对截止点 `D`，`receivedAt <= D` 的 Action 排在该截止点的 Timer 任务之前处理，即使 Action 当时仍在队列等待；“是否已取得执行权”不参与胜负判断。
3. 截止前收到的 Action仍须在执行时通过身份、`expectedSequence`、Turn 与 Engine 合法性校验。若失败，Timer 在轮到时仍可执行自动动作。
4. `receivedAt > D` 的 Action 不执行：若仍指向同一行动机会返回 `ACTION_TIMEOUT`；若状态已被 Timer/其他动作推进则返回 `STALE_GAME_STATE`。
5. 同一截止点前收到多个动作时，按入口序号处理；第一个成功提交的动作推进状态，其余动作通常因 sequence 变化被拒绝。

串行队列、Timer、Scheduler 的实现属 [04](./04-game-server-architecture.md)；本文只定义 wire 可观察行为。

## 8. 消息目录（wire catalog）

命名已统一为“字段 lowerCamelCase、枚举 UPPER_SNAKE_CASE”。HTTP 操作名不进入 wire `type`；Engine Event 名称保持 [01 §14](./01-engine-spec.md#14-game-events区块6-10-v02-612) 的 UPPER_SNAKE_CASE。

### 8.1 Client → Server

| 消息 | 通道 | 说明 | 依据 |
| --- | --- | --- | --- |
| 创建房间 | HTTP | `POST /rooms`；携带昵称与比赛配置，服务端最终校验 | 《总规划》§5.2；《区块6-10 v0.2》§10.11 |
| 邀请码加入 | HTTP | `POST /rooms/join`；邀请码 + 昵称 → 签发身份 | 《区块1-5 v0.1》§4.3；《总规划》§5.2 |
| 低频设置变更 | HTTP | `PATCH /rooms/{roomId}`；仅 Lobby、仅房主，使用显式的配置 Patch Schema；开局后锁定 | 《总规划》§5.2/§7.1 |
| 开始比赛/再来一局 | HTTP | `POST /rooms/{roomId}/tournaments`；仅房主，原子校验 `expectedRoomRevision` 与开局条件 | 《总规划》§2.1/§5.1 |
| `SET_READY` | WS | `{ ready: boolean }`；仅 Lobby | 《区块6-10 v0.2》§7.7 |
| `SUBMIT_ACTION` | WS | §7.2 的动作联合类型 | 《总规划》§3.2；01 §5.1 |
| `USE_TIME_BANK` | WS | `{ tournamentId, expectedSequence }`；以 `requestId` 幂等；Server 控制命令，不进入 Engine Action 联合类型；不限时/未轮到/余额为零时拒绝 | 《区块6-10 v0.2》§7.7；《总规划》§3.1 |
| `REQUEST_SNAPSHOT` | WS | `{ tournamentId, lastSequence, reason }`；`reason` 为 `GAP/INVALID_EVENT/STALE_ACTION/MANUAL` | Snapshot + Event Stream |
| `LEAVE_ROOM` | WS/HTTP | 主动离开；后续状态转移见 01 §13 | 《区块6-10 v0.2》§7.2/§7.7 |
| Hand History | HTTP | `GET /tournaments/{tournamentId}/hands` 游标分页列表；`GET /tournaments/{tournamentId}/hands/{handId}` 获取接收者权限投影后的详情 | [05](./05-frontend-spec.md) §13 |

### 8.2 Server → Client

| 消息 | 说明 | 依据 |
| --- | --- | --- |
| `RECONNECT_RESULT` | 认证后的第一条业务消息；`{ connectionId, resumed, tookOver, roomSnapshot, gameSnapshot? }` | 《区块6-10 v0.2》§10.8 |
| `ROOM_SNAPSHOT` | Lobby 全量投影；携带递增 `roomRevision`，替代含糊的 `ROOM_UPDATED` 增量 | 《区块6-10 v0.2》§7.7 |
| `GAME_SNAPSHOT` | 首次进入、重连、缺序、过期或 Fast Forward 后的完整 `PlayerView` | 《区块6-10 v0.2》§10.8 |
| `GAME_EVENT` | §6.3 信封；事件类型一一对应 01 §14，不再引入 `PLAYER_ACTION/CARD_DEALT` 等第二套聚合名 | 《区块6-10 v0.2》§7.7 |
| `CLOCK_UPDATED` | `{ tournamentId, handId, currentActorPlayerId, actionDeadline, timeBankRemainingMs }`；只更新计时显示，不占用 Game Event sequence | Time Bank / 权威计时 |
| `COMMAND_RESULT` | `{ requestId, actionId?, status, duplicate, appliedSequence?, error? }`；`status` 为 `APPLIED/REJECTED` | 幂等与关联 |
| `RESYNC_REQUIRED` | 服务端无法保证该连接事件连续时，要求客户端请求/接受 Snapshot；不得附带私密内部状态 | Fast Forward |
| `SESSION_REPLACED` | 新设备接管后发给旧连接，随后旧连接关闭 | 多设备接管 |
| `ERROR` | 无法关联到合法命令的连接级/解析级错误；结构见 §11 | 《区块6-10 v0.2》§8.8/§10.8 |

### 8.3 Game Event wire Payload【规范性决定】

`Card` 固定为 `{ rank: "2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"10"|"J"|"Q"|"K"|"A", suit: "CLUBS"|"DIAMONDS"|"HEARTS"|"SPADES" }`；`ActionSource` 固定为 `HUMAN_SOCKET | BOT_CONTROLLER | SYSTEM_TIMER`。`seat` 是 `0..maxPlayers-1` 的整数，所有 `amount/*To/potAmount` 遵守 §4.1 的安全整数规则。`HandRankView` 为 `{ category, tiebreakRanks, label }`，其中 `category` 是标准九级牌型枚举、`tiebreakRanks` 是由强到弱的 Rank 数组，`label` 只供展示。下表字段是 `event.payload` 的必需最小集合；`playerId` 与 `seat` 同时存在是为了历史可读性，服务端仍以 `playerId` 关联身份。

| Event type | wire Payload 必需字段 |
| --- | --- |
| `HAND_STARTED` | `{ handNumber, dealerSeat, smallBlindSeat, bigBlindSeat, blindLevel }` |
| `BLIND_POSTED` | `{ playerId, seat, blindType, amount, betTo }`；`blindType=SMALL_BLIND|BIG_BLIND|ANTE` |
| `DEAL_HOLE_CARD` | `{ playerId, seat, cardIndex, card? }`；`cardIndex=0|1`，`card` 仅目标玩家可见 |
| `BURN_CARD` | `{ street }`；`street=FLOP|TURN|RIVER`，wire 永无牌面字段 |
| `FLOP_DEALT` | `{ cards }`，恰好三张 |
| `TURN_DEALT` / `RIVER_DEALT` | `{ card }` |
| `PLAYER_CHECKED` | `{ playerId, seat, source }` |
| `PLAYER_CALLED` / `PLAYER_BET` / `PLAYER_ALL_IN` | `{ playerId, seat, source, amount, betTo }` |
| `PLAYER_RAISED` | `{ playerId, seat, source, amount, raiseTo, isFullRaise }` |
| `PLAYER_FOLDED` | `{ playerId, seat, source }` |
| `SHOWDOWN_STARTED` | `{ contenderPlayerIds }` |
| `PLAYER_REVEALED` | `{ playerId, seat, cards, handRank }`；公开后所有接收者一致 |
| `UNCALLED_BET_RETURNED` | `{ playerId, seat, amount }` |
| `POT_AWARDED` | `{ potIndex, potAmount, awards, winningHandRank }`；`winningHandRank` 可为 `null`（无人跟注）；`awards[] = { playerId, amount }` 且金额和等于 `potAmount` |
| `PLAYER_ELIMINATED` | `{ playerId, finishPosition, tied }` |
| `PLAYER_WITHDRAWN` | `{ playerId, seat, forfeitedChips }` |
| `TOURNAMENT_FINISHED` | `{ winnerPlayerId, rankings }` |

自动 Check/Fold 不引入第二套 Event 名：仍发送 `PLAYER_CHECKED`/`PLAYER_FOLDED`，并令 `source=SYSTEM_TIMER`。P1 Bot 同理使用普通动作事件且 `source=BOT_CONTROLLER`。

## 9. Snapshot 与投影契约（`PlayerView` / `BotView`）

内部 `GameState` **绝不**直接发送浏览器；服务端按接收者生成 `PlayerView`（《总规划》§5.3）。以下是 P0 必须存在的字段集合；具体共享子类型（`TournamentConfig`、`Card`、`LegalActions`、状态枚举）由 `packages/protocol` 的严格 Schema 定义并导出，TypeScript 类型必须由 Schema 推导，不得手写一份平行类型。

### 9.1 RoomSnapshot【规范性决定】

```ts
type RoomSnapshot = {
  snapshotVersion: 1;
  roomId: string;
  roomRevision: string;
  status: "LOBBY" | "IN_GAME" | "FINISHED" | "CLOSED";
  inviteCode: string | null;
  hostPlayerId: string | null;
  config: TournamentConfig;
  activeTournamentId: string | null;
  players: Array<{
    playerId: string;
    displayName: string;
    seat: number | null;
    ready: boolean;
    connectionStatus: "CONNECTED" | "DISCONNECTED";
    pokerStatus: PokerStatus;
  }>;
};
```

- `roomRevision` 是房间内全量 Snapshot 的递增版本，也编码为十进制字符串；只用于丢弃乱序 Room Snapshot，不用于提交扑克 Action。
- 客户端接受首份 Room Snapshot 后，只应用 `roomRevision` 更大的后续版本；相等或更小的版本视为重复/乱序并忽略。Room revision 允许跳号，因为每条消息都是全量 Snapshot。
- `inviteCode` 在 `CLOSED` 时为 `null`；Snapshot 永不包含任何玩家的 Token。
- 玩家数组按 `seat` 升序、未入座玩家最后并按 `playerId` 稳定排序，避免客户端因无意义重排产生闪烁。

### 9.2 GameSnapshot / PlayerView【规范性决定】

```ts
type GameSnapshot = {
  snapshotVersion: 1;
  reason: "INITIAL" | "RECONNECT" | "RESYNC" | "FAST_FORWARD" | "STALE_ACTION";
  tournamentId: string;
  sequence: string;
  handId: string | null;
  tournamentStatus: TournamentStatus;
  handPhase: HandPhase | null;
  blindLevel: { index: number; smallBlind: number; bigBlind: number; ante: number };
  dealerSeat: number | null;
  board: Card[];
  pots: Array<{ amount: number; eligiblePlayerIds: string[] }>;
  currentActorPlayerId: string | null;
  actionDeadline: number | null;
  players: PlayerPublicView[];
  viewer: {
    playerId: string;
    role: "PLAYER" | "ELIMINATED_SPECTATOR";
    holeCards: Card[];
    legalActions: LegalActions | null;
    timeBankRemainingMs: number;
  };
  rankings: RankingView[];
};
```

`PlayerPublicView` 至少包含 `playerId/displayName/seat/stack/streetBet/totalCommitted/pokerStatus/hasHoleCards/revealedCards`；连接状态的实时权威是最新 `RoomSnapshot.players[].connectionStatus`，不得在两个 Snapshot 中维护两份可独立演进的值。`revealedCards` 仅在规则已公开时出现，否则为空数组。`viewer.holeCards` 只包含该接收者当前合法可见的本人底牌；未发牌、已结束且不可再看等情形为空数组。`legalActions` 仅在 viewer 是当前 actor 时非空，且直接采用 Engine 输出。所有 `*RemainingMs` 字段均为非负整数毫秒。

`CLOCK_UPDATED.timeBankRemainingMs` 指当前 actor 使用后的余额；客户端只有在消息的 `tournamentId + handId + currentActorPlayerId` 与当前视图一致时才应用。它不得改变筹码、行动权、牌面或 `legalActions`。

`PlayerViewPatch` 与上述 GameSnapshot 的牌局视图字段同构，但所有字段均可选；`players` 是以 `playerId` 为键的局部 upsert 数组，其余数组一旦出现就整体替换。字段缺失表示“不变”，显式 `null` 表示“清空”（仅允许在声明为 nullable 的字段）。服务端必须令 `apply(previousView, patch)` 与该 sequence 对应的服务端投影逐字段相等。客户端若遇到未知 Patch 字段、找不到被更新的玩家、类型不符或无法满足该等式所需的不变量，按 §6.4 请求完整 Snapshot。

### 9.3 ReconnectResult【规范性决定】

```ts
type ReconnectResult = {
  connectionId: string;
  resumed: boolean;
  tookOver: boolean;
  roomSnapshot: RoomSnapshot;
  gameSnapshot: GameSnapshot | null;
};
```

`resumed` 表示该玩家此前至少有过一次已认证 WS 连接，不表示增量续传成功；`tookOver` 表示认证时替换了仍活跃的旧连接。P0 每次认证都发送完整 Snapshot。`connectionId` 仅用于诊断当前连接，不是身份凭证。

### 9.4 字段级可见性

字段级隔离（《区块6-10 v0.2》§7.9/§8.6）：

| 信息 | 可见性 |
| --- | --- |
| 未公开 Hole Cards | 仅牌的所属玩家本人可见；Fold 后未公开底牌继续保密 |
| 已通过 `PLAYER_REVEALED` 公开的 Hole Cards | 所有当前授权接收者可见 |
| Deck 顺序 | 永不进入客户端或 AI |
| Burn Card 牌面 | 只发送"发生 Burn"事件，**永不携带牌面** |
| AI 私有 Reasoning/Prompt | 永不进入任何 Payload |

- 淘汰观战者（`ELIMINATED_SPECTATOR`）接收所有公开 Game Event；私有发牌字段一律删除，`viewer.holeCards=[]`、`legalActions=null`。P0 不支持外部自由观战（《区块6-10 v0.2》§7.18；《总规划》§5.3）。
- P1 的 AI 使用独立 `BotView`，遵守与真人相同的信息可见边界（《区块6-10 v0.2》§7.9；《总规划》§8）。
- 投影必须从**服务端源头删除**未授权信息；严禁"先发送再用 CSS 隐藏"（《总规划》附录 B 红线 2；《区块6-10 v0.2》§8.6）。
- 验收：字段级测试——任何非授权 Payload 不得包含其他底牌、Deck、Burn Card 或服务端私密字段（[06](./06-testing-strategy.md) §7；《总规划》§9.1；《区块6-10 v0.2》§9.13）。

事件投影必须保持 `type/tournamentId/sequence/handId` 一致，只删除或替换 Payload 中的受限字段，不得为不同接收者重新编号。`DEAL_HOLE_CARD` 对目标玩家可带 `card`，对其他接收者只保留公开的目标座位/发牌发生事实；`BURN_CARD` 对所有外部接收者均不带牌面。

## 10. 连接生命周期与重连

- `ConnectionStatus` 与 `PokerStatus` 解耦：断线只改 `ConnectionStatus`，不改变任何扑克状态（`PokerStatus=ACTIVE` 与 `ConnectionStatus=DISCONNECTED` 可共存）（《区块6-10 v0.2》§6.3/§7.17）。
- 断线玩家保留 Seat、筹码与本手已投入筹码；有限时下轮到其行动按普通超时 Auto Check/Auto Fold；不限时下保留 **10 分钟断线宽限**（《总规划》§4.1；《区块6-10 v0.2》§8.1）。
- 刷新、Wi-Fi/蜂窝切换、手机后台恢复**走同一重连流程**：恢复后重连并获取最新 Snapshot（《区块6-10 v0.2》§7.17/§8.3）。
- 断线满 10 分钟或用户确认"主动离开比赛" → `EXIT_PENDING` → 安全结算点转 `WITHDRAWN`（状态转移与筹码语义见 [01 §13](./01-engine-spec.md)；协议层负责 `LEAVE_ROOM` 消息与状态推送）。
- 多设备接管：新连接完成认证并建立 Snapshot 屏障后，服务端原子提升其 `connectionEpoch`；旧连接从这一刻起提交的命令均返回 `SESSION_REPLACED`。服务端尽力向旧连接发送 `SESSION_REPLACED`，随后以 WS Close Code `4001` 关闭；即使通知丢失，旧连接也不得再取得控制权。
- 房间关闭：房间中已无真人 → 停止计时与 AI 决策、房间转 `CLOSED`、比赛记录为 `ABANDONED_NO_HUMAN`、邀请码立即失效（《总规划》§4.2）。
- `FINISHED → LOBBY` 保留邀请码与配置；"再来一局"创建**新 Tournament**，不复用旧牌局状态（《总规划》§5.1；《区块6-10 v0.2》§7.3）。

P0 不做“从 lastSequence 增量续传”：所有首次连接、刷新、网络切换、后台恢复都先取完整 Snapshot，再从屏障后的下一个 Event 继续。`RESYNC_REQUIRED` 可由服务端在发送队列积压超过实现阈值时主动发出；该连接之后的旧积压事件可丢弃，但必须用新 Snapshot 重新建立屏障。

应用私有 Close Code 固定为：`4000 PROTOCOL_ERROR`、`4001 SESSION_REPLACED`、`4003 AUTH_FAILED`、`4008 HEARTBEAT_TIMEOUT`。Close reason 只用于诊断；业务 UI 仍以最后收到的稳定 ErrorCode 分支，未收到 Error 时才回退到 Close Code。

## 11. ErrorCode 规范

- 使用**稳定 Error Code**，不把内部堆栈直接返回用户（《区块6-10 v0.2》§8.8）。本文是 wire ErrorCode 的唯一权威。
### 11.1 ErrorEnvelope【规范性决定】

```ts
type ProtocolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  traceId: string;
  details?: Record<string, string | number | boolean | null>;
};

type ErrorEnvelope = {
  error: ProtocolError;
};
```

WS `ERROR.payload` 与 `COMMAND_RESULT.payload.error` 均复用 `ProtocolError`；HTTP 失败直接返回 `ErrorEnvelope`。`message` 仅供诊断/展示，可能调整或本地化，调用方只能依据 `code` 分支。`details` 使用按错误码列白名单的安全字段，例如 `currentSequence`、`minRaiseTo`、`retryAfterMs`；不得包含堆栈、SQL、Token、牌堆或其他玩家私有信息。

### 11.2 P0 完整错误码【规范性决定】

| 类别 | ErrorCode | 典型触发与客户端行为 |
| --- | --- | --- |
| 协议 | `INVALID_MESSAGE` | JSON/Schema/未知消息错误；修正客户端，不自动重试 |
| 协议 | `UNSUPPORTED_PROTOCOL_VERSION` | 主版本不支持；停止连接并提示刷新/升级 |
| 身份 | `AUTH_REQUIRED` / `AUTH_FAILED` | 未认证或 Token 无效；停止重试并回到加入流程 |
| 身份 | `FORBIDDEN` / `SESSION_REPLACED` | 无权限或已被新连接接管；不重试原命令 |
| 限流 | `RATE_LIMITED` | 按 `details.retryAfterMs` 退避 |
| 房间 | `ROOM_NOT_FOUND` / `INVALID_INVITE_CODE` / `INVITE_EXPIRED` | 重新输入邀请或回首页 |
| 房间 | `ROOM_FULL` / `NICKNAME_INVALID` / `NICKNAME_TAKEN` | 修改加入参数后重试 |
| 房间 | `ROOM_LOCKED` / `NOT_HOST` / `PLAYER_NOT_SEATED` | 刷新 Room Snapshot，不自动重复命令 |
| 房间 | `STALE_ROOM_STATE` | `expectedRoomRevision` 与当前值不相等；返回/推送最新 Room Snapshot |
| 牌局 | `TOURNAMENT_NOT_ACTIVE` / `NOT_YOUR_TURN` / `INVALID_ACTION` / `INVALID_AMOUNT` | 状态不变；以 Snapshot/LegalActions 修正 UI |
| 牌局 | `ACTION_TIMEOUT` | `receivedAt > actionDeadline` 且仍指向同一行动机会；不执行，等待同步 |
| 牌局 | `STALE_GAME_STATE` | `expectedSequence` 与当前值不相等或动作机会已推进；接受随后的 Snapshot |
| 幂等 | `IDEMPOTENCY_KEY_REUSE` | 相同 `actionId` 携带不同 Payload；生成新动作前先同步 |
| 计时 | `TIME_BANK_DISABLED` / `TIME_BANK_EMPTY` / `TIME_BANK_NOT_AVAILABLE` | 不限时、余额为零或当前不可使用；不改变牌局状态 |
| 服务 | `GAME_UNAVAILABLE` | 该桌被冻结/恢复中；可按服务端提示重试 |
| 服务 | `INTERNAL_ERROR` | 未分类服务端错误；状态不得由客户端推断，按 `retryable` 处理 |

HTTP 推荐映射：Schema 400、认证 401、权限 403、不存在 404、冲突/陈旧 409、限流 429、内部故障 500/503。同一 ErrorCode 在 HTTP 与 WS 中必须保持相同语义。

- 服务端结构化日志至少包含 `roomId`、`tournamentId`、`handId`、`playerId`、`eventSequence`、`action`、`errorCode`；禁止记录 API Key、`playerToken` 等敏感凭证（《区块6-10 v0.2》§8.11）。

## 12. Failure Handling

| 失败场景 | 检测方式 | 处理 | 对调用方可见的结果 |
| --- | --- | --- | --- |
| 重复 Action | `actionId` 幂等去重 | 同一 `actionId` 最多执行一次并缓存原结果 | `COMMAND_RESULT.duplicate=true`，无二次副作用 |
| Event 缺失/重复 | `sequence` 检查 | 重复忽略；缺序暂停 Action 并请求 Snapshot | `REQUEST_SNAPSHOT` → `GAME_SNAPSHOT` |
| 过期 Action | `expectedSequence` 校验 | 拒绝并下发最新 Snapshot | `STALE_GAME_STATE` |
| 畸形/越权 Payload | Schema Validate + 服务端再校验（金额、Turn、身份） | 拒绝，状态不变 | 稳定错误码 |
| 超时与 Action 竞争 | `receivedAt` 与单调时钟裁决（§7.4） | 截止前已记录 Action 先于 Timer；逾期不执行 | `ACTION_TIMEOUT` / `STALE_GAME_STATE` |
| 断线 | WS 关闭 | §10 流程；牌局继续，不阻塞整桌 | `ConnectionStatus=DISCONNECTED` |
| 邀请码枚举 | 加入接口 Rate Limit | 拒绝 | 错误码 |
| AI 请求失败（P1） | Timeout/500/非法 JSON | Fallback；牌局不停（属 `server/ai`） | 牌局继续 |
| 数据库故障 | — | GameState 继续在内存执行；Hand Events/Snapshot 异步或按 Hand 批量持久化，具体降级上限由 game-server 架构规定 | P0 牌局继续 |

## 13. Security Considerations

- **信任边界**：客户端不可信；所有外部输入先 Schema Validate 再进入业务层（《区块6-10 v0.2》§10.8）。服务端对金额、Turn 权、Raise 权、Player 身份**再次校验**（《总规划》附录 B 红线 4；§8.8）。
- **传输与凭证**：生产环境只允许 HTTPS/WSS；Token 不进入 URL，认证帧禁止采样；HTTP Bearer Token 与 Room 权限绑定。
- **防滥用**：邀请/加入接口 Rate Limit 防批量枚举邀请码；Action 接口 Rate Limit 防刷请求（《区块6-10 v0.2》§8.7/§8.8）。
- **XSS**：昵称限制长度、服务端校验与输出转义（《区块6-10 v0.2》§8.8）。
- **密钥隔离**：DeepSeek API Key 只存服务端，不进入前端、LocalStorage、WebSocket Payload 或日志（《区块6-10 v0.2》§8.5）。
- **AI 输出不是最终动作**：必须先过 JSON Schema Validation 与 Engine Legal Action Validation；Engine 只拒绝非法 Action，不猜测 LLM 原意（《区块6-10 v0.2》§8.4）。
- **Prompt Injection**：AI Context 使用结构化 JSON 与固定字段，不把用户输入拼成自然语言指令；`displayName` 只作为数据字段（《区块6-10 v0.2》§8.9）。
- **私有信息**：投影在服务端源头完成，不依赖前端配合（§9；《总规划》红线 2）。

## 14. Invariants（协议层）

| 不变量 | 表述 | 依据 |
| --- | --- | --- |
| 序列单调 | 同一桌的 Event `sequence` 单调递增，且与状态转移顺序一致 | 《总规划》§5.2；《区块6-10 v0.2》§9.11 |
| 快照屏障 | Snapshot.sequence 恰好等于其状态已包含的最后事件，之后首个事件只能是 `sequence + 1` | §6.4 |
| 幂等执行 | 同一 `actionId` 至多执行一次 | 《总规划》§3.2 |
| 投影完整性 | 任何投递给接收者的 Payload 不含其无权获得的信息（字段级） | 《总规划》§5.3/§9.1；《区块6-10 v0.2》§9.13 |
| 单活跃连接 | 一个 `playerToken` 至多一个活跃控制连接 | 《区块6-10 v0.2》§7.17 |
| 计时权威 | 服务器时钟是唯一计时权威；客户端倒计时仅展示 | 《总规划》§3.2；《区块6-10 v0.2》§7.14 |
| 回执非状态 | `COMMAND_RESULT` 不作为客户端状态转移输入；Snapshot/Event 才是状态来源 | §7.3 |

校验位置：重复 `actionId`/缺失 sequence/过期 Action 的行为见 [06-testing-strategy.md](./06-testing-strategy.md) §6 WebSocket 测试项；投影完整性见 06 §7 字段级测试（《总规划》§9.1；《区块6-10 v0.2》§9.13）。

## 15. Known Limitations

- 内存运行 + 关键状态持久化：每手结束保存 Snapshot；**服务进程崩溃后进行中 Hand 的无损恢复不是 P0 硬要求**（《总规划》§7.2；《区块6-10 v0.2》§7.19）。
- 断线期间的旧动画不重放（可通过 Hand History 查看发生了什么）（《区块6-10 v0.2》§7.8）。
- P0 无外部自由观战；仅本场淘汰参赛者（`ELIMINATED_SPECTATOR`）可看公开信息，且只读（《总规划》§5.3；《区块1-5 v0.1》§4.9）。
- 单实例模块化单体：无水平扩容、多区域部署；每桌状态串行是唯一并发模型（《区块6-10 v0.2》§7.20）。
- 无 Pre-action（复杂预操作留待后续）（《区块1-5 v0.1》§5.7）。
- P0 重连总是全量 Snapshot，不支持按 `lastSequence` 补发断线期间事件；因此不会重播旧动画。
- 幂等缓存驻留内存；若服务进程崩溃，进行中 Hand 的 Action 去重记录可能随之丢失，这与 P0 不保证进行中 Hand 无损恢复的边界一致。
- 协议 v1 不承诺跨主版本向后兼容；不支持的客户端必须刷新/升级。

## 16. Design Notes（为什么）

- **为什么是 Snapshot + Event Stream 而不是纯事件日志重放**：断线不重放旧动画（§7.8），积压可 Fast Forward（§8.13），慢动画/慢设备不能阻塞服务端也不能拖住整桌（《区块6-10 v0.2》§7.10）。
- **为什么协议类型放独立 `packages/protocol`**：前后端共享 Action/Event/Config/ErrorCode/PlayerView 类型，减少协议漂移（§10.4）；同时 `poker-engine` 保持零网络依赖（§10.6）。
- **为什么 `actionId` 与 `expectedSequence` 并存**：解决两个不同问题——`actionId` 防御网络重试造成的重复执行；`expectedSequence` 防御基于过期状态提交（《总规划》§3.2）。
- **为什么超时裁决在服务端**：裁决点 = 服务端接收与串行化顺序，而非按钮点击时刻，因此对网络快慢一致、可重放、可测试（《总规划》§3.2）。
- **为什么 HTTP/WS 分工**：低频操作不值得维护长连接；实时推送与双向 Action 需要 WebSocket（《区块6-10 v0.2》§7.2）。
- **为什么 AI 与真人共用动作结构**：P1 只是“在现有座位加入 BOT 参与者”；Bot Controller 复用 §7.2 的动作 Payload 与 Engine 校验，但不伪装成外部 WebSocket 玩家连接（《总规划》§1）。
- **为什么 sequence 用字符串**：协议生命周期内可能超过 JavaScript 安全整数；十进制字符串能保持跨语言精度，比较成本相对牌局消息量可忽略。
- **为什么重连不用事件补发**：产品明确不重播断线动画；全量投影能缩小客户端恢复状态机，并与 Fast Forward 使用同一条可靠路径。
- **为什么 `USE_TIME_BANK` 不是 Engine Action**：它改变 Server 权威 Timer，不改变扑克规则状态；成功后用 `CLOCK_UPDATED` 同步显示，下一次扑克状态转移仍由 Engine Event 推进 sequence。

## 17. 决策登记（无开放 TBD）

原 TBD 已全部形成 P0 协议决定，以保持编号稳定供其他文档引用：

| # | 状态 | P0 决定 | 落点 |
| --- | --- | --- | --- |
| 1 | 已裁决 | 字段 lowerCamelCase、枚举 UPPER_SNAKE_CASE；事件名只采用 01 §14 | §4.1/§8 |
| 2 | 已裁决 | 冻结 P0 错误码表 | §11.2 |
| 3 | 已裁决 | 统一为 `expectedSequence` | §7.1 |
| 4 | 已裁决 | `USE_TIME_BANK` 是 Server 控制命令，不属于 Engine Action | §8.1/§16 |
| 5 | 已裁决 | WS Ping 15 秒、无活动 45 秒判定断线 | §4.3 |
| 6 | 已裁决 | 冻结三个 Snapshot 边界与最小字段 | §9.1–§9.3 |
| 7 | 已裁决 | Hand History 通过 HTTP GET 拉取 | §4.2 |
| 8 | 已裁决 | P0 主版本 1；不支持的主版本硬拒绝 | §4.1/§15 |
| 9 | 已裁决 | 新连接建立屏障后原子接管；旧连接通知后以 4001 关闭 | §10 |
| 10 | 已裁决 | Token 仅由 HTTP 创建/加入响应签发，WS 首帧提交认证 | §4.3/§5 |
| 11 | 已裁决 | 淘汰观战者接收全部公开投影事件，无私有牌与 LegalActions | §9.4 |
| 12 | 已裁决 | 所有筹码金额强制安全整数 | §4.1/§7.2 |
| 13 | 已裁决 | 错误含 `code/message/retryable/traceId/details?` | §11.1 |

产品配置参数已冻结：有限时行动档位为 `15/20/30/45/60` 秒，另允许 `UNLIMITED`；Time Bank 总额为 `0/30/60/120` 秒，单次最多延长 30 秒且每个行动机会最多成功一次。wire 继续以安全整数秒承载，`TournamentConfig` 校验权威见 [01](./01-engine-spec.md) §12，UI 见 [05](./05-frontend-spec.md) §6.2。

## 18. 来源与冲突记录

规划文档链：《区块1-5 v0.1》(2026-08-20) → 《区块6-10 v0.2》(2026-08-20) → 《总规划》v1.0 (2026-08-20，声明"已合并区块 1–10 与本轮决策")。本文以《总规划》v1.0 为最高依据。

| # | 冲突点 | 旧版本 | 新版本 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 技术栈与目录 | 《区块6-10 v0.2》§10.1/§10.2/§10.5：Vite + React、Zustand、`apps/server` | 《总规划》§6：Next.js 16 + React 19 + Jotai + Radix、`apps/game-server` + `@fastify/websocket` | 以《总规划》为准；影响本文引用的路径 |
| 2 | 主动退出语义 | 《区块1-5 v0.1》§4.8：退出后视为 Sitting Out，继续缴盲自动 Fold 直至自然淘汰 | 《总规划》§4.1：`EXIT_PENDING` → 安全结算点转 `WITHDRAWN`，未投入筹码记 `forfeitedChips` | 以《总规划》为准（与 01 §21 冲突 1 同族，此处只记协议可见部分） |
| 3 | Time Bank 消耗方式 | 《区块6-10 v0.2》§7.15：按 20/30 秒一段消耗 | 《总规划》§3.1：一次延长固定时段（如 30 秒）或剩余余额中较小者 | 以《总规划》为准（同 01 §21 冲突 3，不重述） |
| 4 | §7.7 消息表与 Action/事件目录 | §7.7 的 Client 消息表缺 `BET`；Server 消息族名与 §6.12 事件目录未映射 | 01 §5.1 Action 全集含 `Bet`；事件目录权威在 01 §14 | Action 类型全集以 01 §5.1 为准；wire 命名与一一映射已在 §8 与 §17 决策 1 冻结 |

《总规划》v1.0 新增、docx 未覆盖的决策（本文已吸收）：`ACTION_TIMEOUT` 错误码与 `receivedAt` 裁决（§3.2）；`ABANDONED_NO_HUMAN` 与 `CLOSED` 后邀请码立即失效（§4.2）；断线满 10 分钟 `EXIT_PENDING`（§4.1）；不限时模式强制禁用 `USE_TIME_BANK`（§3.1）；P0 开局 ≥2 真人（§2.1）。

规划书是产品意图、非实现事实：本文所有实现类陈述在代码落地前一律视为设计意图（见文首标记）。
