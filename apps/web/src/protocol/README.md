# Client transport boundary

TEX-23 的唯一 HTTP/WebSocket 客户端入口。请求、成功响应、错误信封和服务端消息均使用 `@texas-holdem/protocol` 的公开严格 Schema；本目录不复制 DTO、扑克规则或服务端行为。

- `http-transport.ts`：64 KiB 上限的 JSON 请求、Bearer 与 Idempotency-Key，诊断仅含 method/path/status/code。
- `websocket-transport.ts`：单连接认证、可重试的稳定命令信封、协议校验与重同步边界；Socket 与 UUID 可注入测试。
- `token-store.ts`：仅内存与按 roomId 隔离的 `sessionStorage`；不使用 localStorage、IndexedDB、URL 或日志。

Transport 绝不把 `COMMAND_RESULT` 当作牌局状态来源。完整状态由 `state/` 中的 Snapshot/Event 消费器维护。
