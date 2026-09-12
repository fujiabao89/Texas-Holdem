# rooms — Room/Lobby 权威状态与串行执行

TEX-52：CLOSED 提交后同步失效邀请码/鉴权、发布最后 RoomSnapshot；停止队列入口并等待在途控制事务、关联 Tournament 清理后删除重型 Runtime。保留期仅保留 `{roomId, closedReason, closedAt}` 三字段 tombstone 10 分钟，timer 使用独立 closure，不能保留原成员/凭证。迟到请求沿用 `ROOM_NOT_FOUND`（不新增 wire 错误码）。`runtimeCounts()` 区分 registered / active / closedTombstones；`dispose()` 只卸载内存，不把关停误持久化成 CLOSED。来源 Tournament 的 CLOSE 命令在 Room 队列执行点验证 activeTournamentId，旧赛不能关闭新赛。

进程关停会先拒绝尚未准入的 `createRoom`，但等待已进入持久化事务的创建完成运行时注册与凭证返回，再统一卸载运行时；不得在 DB 已提交后因 `disposed` 丢弃响应而制造无人持有 Token 的持久化 Room。

`runtime-lifecycle.test.ts` 使用真实 managers/Writer/epochs 与 Fake Clock，24 房间 / 72 场 / 多批次验证每轮终局保留、关房墓碑及清理后对象数回到零，记录 heap/RSS 但不依赖 GC；另覆盖卸载后待提交 Bundle 保留并继续完成提交与迟到 timer。失败重试回收另由 `tournaments/tournament-lifecycle.test.ts` 覆盖。

`room-lifecycle-races.test.ts` 覆盖终局动作重放/快照、延迟清理时 LEAVE 回执、下游释放失败和订阅者异常。广播逐观察者隔离异常，继续执行全部权限撤销与清理；生产通过安全 Room ID 诊断，观察者错误不回滚已提交状态。

TEX-51：`registerRecovered` 仅供启动屏障使用，注册已验证的成员/摘要/Host/邀请码和比赛关联；失败用 `unregisterRecovered` 撤销本次注册。`RoomRuntime` 在持久化前检查 revision 号段上界，跨重启预留规则见 [ADR-0003](../../../../docs/adr/0003-tex-51-room-recovery-authority.md)。Lobby 重启后 seat=null、ready=false、全部断线；比赛座位以锁定参赛者为准。

权威规格：[docs/04-game-server-architecture.md](../../../../docs/04-game-server-architecture.md) §5；wire 契约引用 [docs/02-protocol-spec.md](../../../../docs/02-protocol-spec.md) §4/§5。

- **内存权威**：seat/ready/connectionStatus/activeTournamentId 只在内存；`rooms`/`room_players` 不落这些运行态，DB 只记录身份、成员关系、状态、配置与 Host（docs/03 §5）。
- **串行执行**：`room-executor.ts` 每个 Room 一个串行队列；HTTP/WS 只能经 `RoomManager.submitCommand` 投递命令，不得直接 mutate。控制面先提交（先持久化成功再确认），避免半提交与检查后写入竞态；WS 的 Ready/普通离开命令在取得队列执行权时复核连接 epoch，已由 Tournament 确认的撤回只做后续成员清理。
- **比赛中离开**：Tournament 先权威确认 `WITHDRAW_PLAYER`，再由 Room 串行移除成员、撤销 Token/转移 Host；HTTP 与 WS 走同一顺序。
- **状态机**：`LOBBY → IN_GAME → FINISHED → LOBBY`，任意态可转 `CLOSED`；`roomRevision` 单调递增、只增不回退。「再来一局」由 `START_TOURNAMENT` 在单命令内原子完成 FINISHED→LOBBY→IN_GAME：`expectedRevision` 校验提交前状态，中间 `LOBBY` 不暴露、不落库。
- **恢复后的再来一局**：终局恢复保持当前真人的 `ready=true`，与未重启的 FINISHED 运行时一致，使 Host 仍可直接提交下一场；LOBBY/IN_GAME 恢复不伪造 Ready。
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
| `leave-coordinator.ts` | HTTP/WS 共享离开编排；先确认 Tournament 撤回，仅用本次短订阅捕获的 CLOSED 权威快照和 tombstone 确认关房已完成，finally 解除订阅，不向墓碑保留快照 |

`room-lifecycle-races.test.ts` 使用真实 Room/Tournament managers 与 gateway，覆盖终局 Action 幂等重放与最终 Snapshot、延迟清理后的最后 LEAVE 回执、全下后最后真人退出的 HTTP/WS 关房交错、观察者/最终帧发送失败后的清理。

`leave-coordinator.test.ts` 验证本次 CLOSED 快照 + tombstone + 已确认撤回三项证据缺一不可，排队关闭仅接受确定的关闭错误，撤回/持久化失败不被吞掉，所有路径均解除临时订阅。
