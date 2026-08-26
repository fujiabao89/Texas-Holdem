# persistence（TEX-22）

持久化运行时编排：异步 Writer 与崩溃恢复。权威规格：docs/03-data-model.md §4/§7、docs/04-game-server-architecture.md §12/§13。

## 模块

| 文件 | 职责 |
| --- | --- |
| `persistence-writer.ts` | 唯一写者的异步编排：接收 `HandCommitBundle`，按 Tournament 严格串行、全局最多 8 路并发写 PostgreSQL；瞬态失败指数退避（`250ms × 2^attempt` ±20% jitter、最高 30s）；items/bytes/age 三维 soft/hard watermark；`PersistenceError` 数据损坏隔离；`flush` 供优雅关停。 |
| `recovery.ts` | 崩溃恢复编排：定位活跃比赛 → 校验快照（版本/checksum/事件连续性/序列对齐）→ `TournamentEngine.restore` 重建运行时；不可验证向前退回（含 `rollbackToSnapshot`）；无可验证根则隔离并上报。 |

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
