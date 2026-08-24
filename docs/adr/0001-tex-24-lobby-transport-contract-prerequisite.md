# ADR-0001：TEX-24 Lobby 需要完整的 HTTP 响应 Schema 与可用 WS 运行时

> 状态：提议（TEX-24 阻塞）  
> 日期：2026-08-24

## 背景

TEX-24 的创建、加入、选座、配置、踢人和开局前流程必须只消费
`packages/protocol` 导出的运行时 Schema，并由服务端 `RoomSnapshot` 作为唯一
房间状态来源。

当前 `packages/protocol` 只导出创建/加入和 Hand History 的 HTTP 成功响应 Schema。
TEX-19 的下列受保护端点在路由实现内返回了成功对象，但协议包没有相应的公开
Schema：

- `PATCH /api/v1/rooms/{roomId}` → `{ data: { roomSnapshot } }`
- `POST /api/v1/rooms/{roomId}/tournaments` → `{ data: { tournamentId, roomSnapshot } }`
- `POST /api/v1/rooms/{roomId}/leave` → `{ data: { roomSnapshot } }`

此外，`apps/game-server` 已声明实时层的职责，但 `origin/main` 未注册
`GET /api/v1/ws` 运行时。创建/加入响应可以初始化当前导航的投影，却不能在刷新、
直达房间 URL、断线或其他成员变动后获得服务器权威的 `RECONNECT_RESULT` /
`ROOM_SNAPSHOT`。

在 Web 端用 Zod 拼出上述响应，或在组件中以断言读取未验证的 JSON，都会形成平行
DTO，违反 `docs/05-frontend-spec.md` §5.3 与 TEX-24 的明确边界。因此不能以
前端模拟状态替代这些依赖。

## 决定

在页面接线前补齐以下最小前置条件：

1. 在 `packages/protocol` 导出并由 TEX-19 路由使用：
   `UpdateRoomResponseSchema`、`StartTournamentResponseSchema` 与
   `LeaveRoomResponseSchema`，以及由它们推导的类型。Schema 只复用既有
   `RoomSnapshotSchema`、`OpaqueIdSchema` 和 `HttpDataEnvelopeSchema`，不新增
   wire 字段或改变 HTTP 语义。
2. 在 `apps/game-server` 注册 `GET /api/v1/ws`：强制首帧 `AUTHENTICATE`，成功
   后首先发送 `RECONNECT_RESULT`，并在 Lobby 状态改变时广播已投影且经 Schema
   校验的 `ROOM_SNAPSHOT`。认证、Token 失效和关闭房间的行为保持 `docs/02` 的既有
   规定。
3. 上述工作应在拥有 `packages/protocol/**` 与 `apps/game-server/**` 的 Linear
   任务中完成，并附带协议/WS 测试；TEX-24 仅在其合入 `main` 后继续。

## 后果

- TEX-24 不改变协议、服务端或运行时语义，也不在前端创建替代 Schema。
- 前置条件合入后，TEX-24 可将 HTTP 成功响应和 WebSocket 投影直接交给
  `ProjectionStore`，并正确支持刷新、重连和多成员 Lobby 更新。
- 当前 TEX-24 页面、Transport 可靠性改动与 E2E 不应开始，避免交付只能在单次
  内存导航中工作的 Lobby。
