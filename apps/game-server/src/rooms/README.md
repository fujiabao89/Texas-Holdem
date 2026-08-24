# rooms — Room/Lobby 权威状态与串行执行

权威规格：[docs/04-game-server-architecture.md](../../../../docs/04-game-server-architecture.md) §5；wire 契约引用 [docs/02-protocol-spec.md](../../../../docs/02-protocol-spec.md) §4/§5。

- **内存权威**：seat/ready/connectionStatus/activeTournamentId 只在内存；`rooms`/`room_players` 不落这些运行态，DB 只记录身份、成员关系、状态、配置与 Host（docs/03 §5）。
- **串行执行**：`room-executor.ts` 每个 Room 一个串行队列；HTTP/WS 只能经 `RoomManager.submitCommand` 投递命令，不得直接 mutate。控制面先提交（先持久化成功再确认），避免半提交与检查后写入竞态。
- **状态机**：`LOBBY → IN_GAME → FINISHED → LOBBY`，任意态可转 `CLOSED`；`roomRevision` 单调递增、只增不回退。
- **开局**：`TournamentStarter` port（`tournament-starter.ts`）由 TEX-20 注入运行时；默认实现仅单事务落库 Tournament + locked players + Room→IN_GAME，不实现 Hand 循环、不伪造 Engine 结果。
- **凭证**：`playerToken` 256-bit 熵、仅创建/加入响应返回；HMAC 摘要落库（`infrastructure/persistence/player-token.ts`）；鉴权由 token 摘要反查 `playerId`。
- **邀请码**：31 字符字母表、无偏 rejection sampling、最多 10 次冲突重试（`invite-code.ts`）。

模块：

| 文件 | 职责 |
| --- | --- |
| `room-runtime.ts` | 不可变 RoomState 与纯迁移（join/leave/seat/ready/config/kick/host-transfer/start/close）与 RoomSnapshot 投影 |
| `room-executor.ts` | 唯一串行执行器 + 命令处理（先持久化后提交） |
| `room-manager.ts` | Room 集合、邀请码路由、创建/加入编排、token 摘要鉴权、可注入 Host 转移入口 |
| `room-persistence.ts` | RoomRepository 领域适配（复用 TEX-18 事务边界） |
| `tournament-starter.ts` | TournamentStarter port + 默认持久化实现 |
| `invite-code.ts` / `player-token.ts` / `id-source.ts` | 可注入的邀请码/token/身份/时钟来源 |
| `room-errors.ts` | 领域错误（稳定 ErrorCode + 白名单 details） |
