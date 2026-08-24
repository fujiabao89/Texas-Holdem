# http — HTTP 入口与安全

权威规格：[docs/04-game-server-architecture.md](../../../../docs/04-game-server-architecture.md) §10；wire 契约引用 [docs/02-protocol-spec.md](../../../../docs/02-protocol-spec.md) §4/§8/§11。

- **只使用 `packages/protocol` 导出 Schema**：`routes/rooms.ts` 全部外部输入先经 `CreateRoomRequestSchema` 等运行时 Schema 校验；成功 `{ data }`、失败 `ErrorEnvelope`（`errors.ts` 映射稳定 ErrorCode + 推荐 HTTP 状态码）。
- **鉴权**（`middleware/auth.ts`）：`Authorization: Bearer <playerToken>` → `RoomManager.authenticate` 由 token 摘要反查 `playerId`。
- **幂等**（`middleware/idempotency.ts`）：所有状态变更 `POST/PATCH` 强制 `Idempotency-Key`；作用域 = 身份/源 IP + endpoint + key；同 Payload 复用原结果，同 Key 不同 Payload 返回 `IDEMPOTENCY_KEY_REUSE`。
- **限流**（`middleware/rate-limit.ts`）：进程内 Token Bucket；创建/Join/inviteCode/受保护变更按 docs/04 §10.3 默认额度。
- **Body 上限与 CORS**：`app.ts` 设 64KiB body 上限；CORS 使用显式 Allowlist（不含通配来源）。

错误映射原则：稳定 `error.code` 分支；不泄露堆栈、SQL、Token 或内部房间状态。
