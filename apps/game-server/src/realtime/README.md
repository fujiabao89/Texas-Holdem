# Server realtime

服务端实时传输层。负责协议适配和连接管理，不负责裁决扑克规则。

TEX-24 的 Lobby Gateway 注册 `GET /api/v1/ws`：首帧强制认证，成功后先发送
`RECONNECT_RESULT`，随后只广播服务端 `RoomSnapshot` 投影。Ready/离开命令仍经
`RoomManager.submitCommand` 的串行权威路径处理。

每个 `(roomId, playerId)` 仅保留最新连接；被替换的连接收到
`SESSION_REPLACED` 后关闭。已认证连接每 15 秒 Ping，并在 45 秒未收到 Pong 或
有效入站命令时终止。成员离开或被移出投影后立即取消订阅，避免继续接收房间数据。
