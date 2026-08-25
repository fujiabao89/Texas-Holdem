# Client transport boundary

TEX-23 的唯一 HTTP/WebSocket 客户端入口。请求、成功响应、错误信封和服务端消息均使用 `@texas-holdem/protocol` 的公开严格 Schema；本目录不复制 DTO、扑克规则或服务端行为。

- `http-transport.ts`：64 KiB 上限的 JSON 请求、Bearer、随请求发送的 `Idempotency-Key` 与可注入 timeout/cancel；仅在完整请求 payload 不变时复用同一个键重试，不宣称端到端幂等保证。
- `websocket-transport.ts`：单连接认证、可重试的稳定命令信封、协议校验、重同步与按 `appliedSequence` 回收 pending；Socket、UUID 和时钟可注入测试。
- `token-store.ts`：Token 仅内存与按 roomId 隔离的 `sessionStorage`；同 Tab 的非敏感 playerId 用于将投影识别为当前用户。二者都不使用 localStorage、IndexedDB、URL 或日志，storage 抛错时安全降级到内存。

Transport 绝不把 `COMMAND_RESULT` 当作牌局状态来源。完整状态由 `state/` 中的 Snapshot/Event 消费器维护。
