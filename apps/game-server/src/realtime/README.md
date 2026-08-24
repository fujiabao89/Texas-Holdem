# Server realtime

服务端实时传输层。负责协议适配和连接管理，不负责裁决扑克规则。

TEX-24 的 Lobby Gateway 注册 `GET /api/v1/ws`：首帧强制认证，成功后先发送
`RECONNECT_RESULT`，随后只广播服务端 `RoomSnapshot` 投影。Ready/离开命令仍经
`RoomManager.submitCommand` 的串行权威路径处理。
