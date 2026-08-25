# Gateway

WebSocket 接入、认证握手和消息路由入口。

`lobby-gateway.ts` 仅适配 Lobby 认证、`SET_READY`、`LEAVE_ROOM` 与房间投影广播；
它不直接修改 RoomState，也不向客户端发送 Token 或服务端内部状态。

同一玩家的新连接会原子替换旧连接；心跳为 15 秒 Ping / 45 秒失活关闭。变更命令
按玩家、`requestId` 与完整 payload 复用幂等结果，成员不再存在于权威投影时会撤销
该连接的订阅并关闭连接。
