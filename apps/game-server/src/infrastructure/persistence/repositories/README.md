# Repositories

控制面与手末 Commit Bundle 的数据访问接口/实现（docs/03-data-model.md §5/§7）。

## 接口

| 工厂 | 能力 | 规格 |
| --- | --- | --- |
| `createRoomRepository(database)` | `createRoomWithHost`：Room + 首个 Host 单事务原子写入（插入 rooms → 插入 room_players（含 HMAC 摘要）→ 回填 host_player_id，DEFERRABLE FK 提交时检查） | §5.1/§7.2 |
| `createTournamentRepository(database)` | `createTournamentWithPlayers`：Tournament（`last_committed_sequence=0`）+ 全部 locked players 单事务写入 | §5.3/§5.4/§7.2 |
| `createHandCommitRepository(database)` | `commitHandBundle`：手末 Commit Bundle 单事务原子提交（FOR UPDATE 锁 Tournament 行 → 幂等/部分冲突检查 → 序列完整性验证 → hands + hand_events + game_snapshots + tournament_players 结果更新 + last_committed_sequence + 可选终局更新；`roomStatus=CLOSED` 时以 `roomClosure` 同事务写齐关房元数据） | §5.1/§7.3/§7.4 |

`commitHandBundle` 返回 `"committed"`（首次提交）或 `"already-committed"`（相同 checksum 的安全重试）；同 ID 不同 `commit_checksum` 抛 `CommitChecksumMismatchError`，部分提交抛 `PartialCommitConflictError`，序列缺口/不对齐抛 `SequenceIntegrityError`/`HandSequenceIntegrityError`，`playerUpdates` 目标行不存在或不属于本 Tournament 抛 `TournamentPlayerUpdateTargetError`（均定义在 [errors.ts](./errors.ts)，见 §7.4 —— 不得静默 `ON CONFLICT DO NOTHING`）。

## 输入契约

- **JSON 可序列化**：`commitHandBundle` 的 `payload`/`state` 与 `configJson` 必须是 JSON 可序列化值。`bigint`/`undefined` 等需先转换（如十进制字符串/`Number`，`checksum.ts` 的 canonical 序列化即如此特判）；`bigint` 直传会在插入时抛错并整体回滚，且错误信息不指向真实原因。`Date` 无需转换：canonical 序列化将其编码为 ISO-8601 UTC 字符串（`checksum.ts` 特判，避免落入通用对象分支变成 `{}`）。
- **playerUpdates 归属**：结果更新按 `id + tournament_id` 匹配并断言恰好命中 1 行，杜绝跨赛修改赛果与静默 0 行更新；调用方无需也无法绕过（§7.4）。
- **roomClosure**：`tournamentFinish.roomStatus = "CLOSED"` 时必填（`closedAt`/`closedReason`/`retentionExpiresAt`），且仅在该状态允许——缺失或错配在写入前被 `PersistenceError` 拒绝；只写 `status` 会违反 `rooms_closed_*` CHECK（pg `23514`）并回滚整个 Bundle（§5.1）。
- **昵称**：`createRoomWithHost` 与 `createTournamentWithPlayers` 均在入库前执行 `validateDisplayName`（2–16 grapheme clusters、无控制字符）。
- **inviteCode**：`createRoomWithHost` 不做应用层字符集校验，非法值（含 MULTIPLAYER 缺失，即 NULL）由 DB CHECK（`rooms_invite_code_check`，对 NULL 显式拒绝）兜底并以 pg `23514`（Drizzle 错误的 `cause.code`）抛出；用户侧友好校验/错误翻译由上层（TEX-19）负责。

## 边界

- ID 全部由调用方预生成（`hand_id`/`snapshot_id`/事件序列确定性），幂等重试的前提（§7.4）。
- 只提供写入与验证能力；异步队列、重试调度、恢复编排、投影读取属后续任务（TEX-19～TEX-22）。
