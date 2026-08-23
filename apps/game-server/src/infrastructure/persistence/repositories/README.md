# Repositories

控制面与手末 Commit Bundle 的数据访问接口/实现（docs/03-data-model.md §5/§7）。

## 接口

| 工厂 | 能力 | 规格 |
| --- | --- | --- |
| `createRoomRepository(database)` | `createRoomWithHost`：Room + 首个 Host 单事务原子写入（插入 rooms → 插入 room_players（含 HMAC 摘要）→ 回填 host_player_id，DEFERRABLE FK 提交时检查） | §5.1/§7.2 |
| `createTournamentRepository(database)` | `createTournamentWithPlayers`：Tournament（`last_committed_sequence=0`）+ 全部 locked players 单事务写入 | §5.3/§5.4/§7.2 |
| `createHandCommitRepository(database)` | `commitHandBundle`：手末 Commit Bundle 单事务原子提交（FOR UPDATE 锁 Tournament 行 → 幂等/部分冲突检查 → 序列完整性验证 → hands + hand_events + game_snapshots + tournament_players 结果更新 + last_committed_sequence + 可选终局更新） | §7.3/§7.4 |

`commitHandBundle` 返回 `"committed"`（首次提交）或 `"already-committed"`（相同 checksum 的安全重试）；同 ID 不同 `commit_checksum` 抛 `CommitChecksumMismatchError`，部分提交抛 `PartialCommitConflictError`，序列缺口/不对齐抛 `SequenceIntegrityError`/`HandSequenceIntegrityError`（均定义在 [errors.ts](./errors.ts)，见 §7.4 —— 不得静默 `ON CONFLICT DO NOTHING`）。

## 边界

- ID 全部由调用方预生成（`hand_id`/`snapshot_id`/事件序列确定性），幂等重试的前提（§7.4）。
- 只提供写入与验证能力；异步队列、重试调度、恢复编排、投影读取属后续任务（TEX-19～TEX-22）。
