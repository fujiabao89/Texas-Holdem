# Gateway

WebSocket 接入、认证握手和消息路由入口。

`lobby-gateway.ts` 仅适配 Lobby 认证、`SET_READY`、`LEAVE_ROOM` 与房间投影广播；
它不直接修改 RoomState，也不向客户端发送 Token 或服务端内部状态。
