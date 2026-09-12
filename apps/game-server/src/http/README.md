# http — HTTP 入口与安全

权威规格：[docs/04-game-server-architecture.md](../../../../docs/04-game-server-architecture.md) §10；wire 契约引用 [docs/02-protocol-spec.md](../../../../docs/02-protocol-spec.md) §4/§8/§11。

- **只使用 `packages/protocol` 导出 Schema**：`routes/rooms.ts` 全部外部输入先经 `CreateRoomRequestSchema` 等运行时 Schema 校验；成功 `{ data }`、失败 `ErrorEnvelope`（`errors.ts` 映射稳定 ErrorCode + 推荐 HTTP 状态码）。
- **鉴权**（`middleware/auth.ts`）：`Authorization: Bearer <playerToken>` → `RoomManager.authenticate` 由 token 摘要反查 `playerId`；Room、Hand History 与赛果读取都按凭证 `token_key_id` 使用同一当前/保留密钥环验证。
- **幂等**（`middleware/idempotency.ts`）：所有状态变更 `POST/PATCH` 强制 `Idempotency-Key`；作用域 = 身份/源 IP + endpoint + key；同 Payload 复用原结果，同 Key 不同 Payload 返回 `IDEMPOTENCY_KEY_REUSE`。
- **限流**（`middleware/rate-limit.ts`）：进程内 Token Bucket；创建/Join/inviteCode/受保护变更按 docs/04 §10.3 默认额度。
- **Body 上限与 CORS**：`app.ts` 设 64KiB body 上限；CORS 使用显式 Allowlist（不含通配来源）。
- **比赛中离开**：生产装配注入 TournamentManager；受保护 HTTP Leave 先经 Tournament 撤回，再进入 Room 离开/Token 撤销，与 WS 语义一致。
- **Hand History 投影读取**（`routes/hand-history.ts`，TEX-36）：`GET /api/v1/tournaments/:tournamentId/hands`（列表，`handNumber` 倒序 cursor 分页）与 `GET /api/v1/tournaments/:tournamentId/hands/:handId`（详情）。鉴权走 `room_players.token_digest` 数据库侧 HMAC 反查，只接受未关闭 Room 的 ACTIVE 成员（失效凭证返回 401 `AUTH_FAILED`，不依赖内存 RoomManager）；重复分页参数返回 400。详情校验手内/全局序列连续性及提交 Snapshot 末序列，手间前导事件保留序列并标 `handId: null`；事件经 `state-projector` 接收者视角投影（Burn 牌面/他人底牌/内部 ID 永不出 wire），投影/Schema/连续性失败均返回 500 `INTERNAL_ERROR`。无冠军终局遵循共享 v3 契约，见 [ADR-0002](../../../../docs/adr/0002-tex-36-championless-history.md)。

错误映射原则：稳定 `error.code` 分支；不泄露堆栈、SQL、Token 或内部房间状态。

- **持久化赛果**（`routes/tournament-result.ts`，TEX-54）：共享 UUID/无查询参数 Schema、Room 有效 HUMAN 成员 HMAC 授权、只读一致性事务、严格公开终局响应。排名只覆盖非 WITHDRAWN 玩家并必须形成 `1..N` 连续名次（并列区间可占多个名次），不能让退出玩家掩盖名次空洞。`app.ts` 在限流前设置 no-store，覆盖早期失败；失败只影响该请求且不记录异常本体。完整契约、错误与保留期见 [02](../../../../docs/02-protocol-spec.md) 的 TEX-54 小节，真实 PG 回归见 `tests/integration/tournament-result-read.test.ts`。
