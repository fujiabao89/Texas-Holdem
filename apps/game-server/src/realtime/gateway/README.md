# Gateway

WebSocket 接入、认证握手和消息路由入口。

`lobby-gateway.ts` 适配认证、Lobby 命令、Tournament Action/Time Bank、快照重同步
和服务端投影广播；它不直接修改 RoomState、Tournament Runtime 或 Engine，也不向
客户端发送 Token 或服务端内部状态。

同一玩家的新连接会原子替换旧连接；connection epoch 在 Tournament 队列执行点再次
验证。心跳为 15 秒 Ping / 45 秒失活关闭。变更命令按玩家、`requestId` 与完整
payload 复用幂等结果，成员不再存在于权威投影时会撤销该连接的订阅并关闭连接。

wire v3 握手版本由共享协议包决定；`lobby-gateway.test.ts` 验证 v2 首帧得到 `UNSUPPORTED_PROTOCOL_VERSION`，不会建立旧版本订阅。
