# Lobby feature

TEX-24 的 Home/Create/Join/Lobby 客户端流程：创建或加入的 HTTP 响应、以及 Lobby
WebSocket 的 `RECONNECT_RESULT` / `ROOM_SNAPSHOT` 都先经共享 Schema，再写入
`ProjectionStore`。此目录不复制 Room DTO，也不根据 `COMMAND_RESULT` 乐观修改成员、
Ready、座位、权限或锁定状态。

连接 hook 同时监听浏览器 `online` 与恢复可见，以已有 `WebSocketTransport` 的单连接重试流程提前一次尝试；不创建第二套 WebSocket 或投影缓存。
