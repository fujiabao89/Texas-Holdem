# persistence（TEX-22）

TEX-52：Writer 在 `enqueue` 复制 Bundle 并保留 Buffer/Date/BigInt，嵌套普通对象/数组冻结；不引用 Runtime 可变对象。`releaseTournament` 只退休已存在队列，空且无 in-flight 时回收；pending/in-flight/隔离 Bundle 不丢弃，成功排空后才释放。`queueCount` 观测仍驻留队列。最终 flush 前先停止入口/Runtime，`dispose` 停止重试/age/flush timer；未提交 Bundle 数仍可观测，不伪称已提交。

持久化运行时编排：异步 Writer 与崩溃恢复。权威规格：docs/03-data-model.md §4/§7、docs/04-game-server-architecture.md §12/§13。

## 模块

| 文件 | 职责 |
| --- | --- |
| `persistence-writer.ts` | 唯一写者的异步编排：接收 `HandCommitBundle`，按 Tournament 严格串行、全局最多 8 路并发写 PostgreSQL；瞬态失败指数退避（`250ms × 2^attempt` ±20% jitter、最高 30s）；items/bytes/age 三维 soft/hard watermark；`PersistenceError` 数据损坏隔离；`flush` 供优雅关停。 |
| `recovery.ts` | 崩溃恢复编排：定位活跃比赛 → 校验快照（版本/checksum/事件连续性/序列对齐）→ `TournamentEngine.restore` 重建运行时；不可验证向前退回（含 `rollbackToSnapshot`）；无可验证根则隔离并上报。 |
| `room-recovery.ts` | TEX-51 生产启动屏障：一致 Room/身份元数据 → 配置/锁定座位/检查点/不变量校验 → revision 号段预留及必要控制面协调 → 先 Room 后 Tournament 注册；单房隔离、重复恢复不覆盖现有状态。 |

`prepareTournamentRecovery` 先返回恢复计划，不注册也不立即回退 DB；整条 Room/身份链验证通过后才提交回退。`recoverActiveTournaments` 保留为比赛级测试/兼容入口，生产启动使用完整 Room 屏障。真实进程重启验收见 `tests/integration/room-restart.test.ts`，数据库迁移及诊断见 [恢复运行手册](../../../../docs/05-operations/room-recovery.md)。

## 关键设计

- **内存权威不被 DB 回写**：Writer 只消费执行器内存原子提交后的不可变 Bundle；写失败不回滚内存 GameState、不重放 Action（docs/04 §12.1）。
- **幂等重试**：bundle 携带预生成 ID 与确定性事件序列，重试经仓储幂等判定（`already-committed`）推进，不产生重复行（03 §7.4）。
- **数据损坏**：`PersistenceError` 系列不静默重试/覆盖，隔离该 Tournament 并上报 `onIntegrityError`（§7.4/§13）。
- **序列延续**：恢复后 `engineEventBase` = 快照水位，首 bundle 序列 = 水位 + 1、不重放已提交事件（04 §13；runtime 侧见 `tournaments/tournament-runtime.ts`）。
- **backpressure**：soft 停止创建新 Room、hard 在手间边界暂停（`PAUSE_AFTER_HAND`），回落 ok 恢复。

## 测试

- `persistence-writer.test.ts`（unit）：成功写入、重复投递幂等、退避增长、乱序完成、部分失败、watermark（items/bytes/age）、损坏隔离、flush 超时与排空。全部使用 Fake Clock + Fake `HandCommitRepository`，无真实 DB / sleep。
- `recovery.test.ts`（unit）：正常恢复、水位 0 重初始化、checksum 损坏/事件缺口/版本不兼容/孤立快照的退回或隔离、端到端序列连续性（真实执行器 → 崩溃恢复 → 下一手不重复）。
- 真实 PostgreSQL 恢复仓储（`tests/integration/recovery.test.ts`）：`hasCommittedEventsThrough`、`listActiveTournaments`/`listSnapshots`、`rollbackToSnapshot` 回退事务。
