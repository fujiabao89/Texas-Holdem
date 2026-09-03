# tournaments（TEX-20）

单桌 Tournament 运行时与唯一串行执行器。权威规格：docs/04-game-server-architecture.md §6/§7、docs/02-protocol-spec.md §7、docs/03-data-model.md §7。

## 模块

| 文件 | 职责 |
| --- | --- |
| `tournament-commands.ts` | Tournament 串行队列命令联合类型（Action / Time Bank / Timer 回调 / 撤回 / 连接变化 / 升盲 / 关停）。`receivedAt`/`ingressOrdinal` 是服务端入口元数据，不是 wire 字段。 |
| `tournament-errors.ts` | `TournamentDomainError`（稳定 ErrorCode + 白名单 details，02 §11）。 |
| `tournament-runtime.ts` | 运行时状态（Engine + 玩家映射 + Time Bank + 计时 generation）；`createTournamentRuntimeState` 创建 Engine 权威状态；`createRecoveredTournamentRuntimeState` 从恢复引擎重建（崩溃恢复，TEX-22）；`engineEventBase` 支持恢复后 wire 序列延续；`runtimeView` 输出不可变只读视图。 |
| `tournament-executor.ts` | **核心**：唯一串行执行器。真队列 + 截止点 look-ahead（§7.2）；幂等/sequence/身份/Engine 校验（§7.3）；权威 Action Timer / Time Bank / 断线宽限 / 定时升盲（§8）；无真人关房（§6.5）；撤回流程（§6.6）；手末 Commit Bundle（§12）；`PAUSE_AFTER_HAND` 背压手间边界（§12.2）。 |
| `tournament-persistence.ts` | 手末 Commit Bundle 构造（事件 sequence 对齐、Snapshot 对齐、结果更新），交 `TournamentOutputSink.enqueueCommitBundles`（TEX-22 Writer 消费）；`stateChecksum` 对解析后状态对象计算（恢复侧可等价复算）。 |
| `tournament-manager.ts` | Tournament 集合管理：`create`/`createRecovered`（崩溃恢复）/`submit`/`getView`/`setConnection`（断线/重连入口，供 TEX-21 WS 层调用）/`pauseAll`（背压暂停）/`activeTournamentIds`（优雅关停轮询）。 |

## 关键设计

- **一桌一队列**：所有状态变更、Engine 调用、事件序列、投影与计时回调都经同一串行执行器（红线 3）；其他模块只读 `getView()` 快照或投递命令。
- **截止点仲裁**：对截止点 `D`，所有 `receivedAt <= D` 的 Action/Time Bank 排在 `SYSTEM_TIMER_ACTION` 之前处理（即使仍排在 Timer 之后）；`receivedAt > D` 且仍指向同一行动机会 → `ACTION_TIMEOUT`，否则 `STALE_GAME_STATE`。
- **计时权威**：以可注入 Clock/`TimerScheduler` 为准；Timer 携带 `handId/seatIndex/deadline/generation`，执行前复核、任一不匹配作 stale no-op（§8.2）。
- **幂等**：`actionId + Payload 摘要` 驻留内存账本（§7.3）；相同 Payload 复用原结果，不同 Payload → `IDEMPOTENCY_KEY_REUSE`。
- **无真人关房**：所有真人 `WITHDRAWN` → `ABANDONED_NO_HUMAN` + Room `CLOSE_ROOM`（§6.5）；最后存活者的冠军语义由 Engine 裁决。WS 发起的 `WITHDRAW_PLAYER` 也在执行点复核连接 epoch，Timer 撤回不携带该私有字段。
- **手末提交边界**：手间事件（如两手之间的 `PLAYER_WITHDRAWN`）作为下一手 bundle 的前导事件落入同一原子提交；DB Writer（TEX-22）需据此验证（见 `tournament-persistence.ts` 注释）。
- **Wire 主版本**：输出 `GAME_EVENT` 始终复用 `@texas-holdem/protocol` 的 `PROTOCOL_VERSION`，使包含必填公开 `bestFiveCards` 的 Showdown 合约不会与旧客户端静默混用。

## 测试

`*.test.ts` 覆盖（unit 层，经根 `pnpm test:unit`）：串行化、receivedAt 截止裁决、Time Bank、断线/宽限/无真人、重复/非法/过期命令、事件 sequence 与 Commit Bundle、time 模式升盲、Room↔Tournament 开局/终局闭环。全部使用 Fake Clock + 注入随机源，无真实 DB / sleep。
