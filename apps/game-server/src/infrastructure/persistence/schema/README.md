# Schema

Drizzle 表定义（docs/03-data-model.md §5 的字段级实现；8 张核心表 + 10 个枚举）。

| 文件 | 表 |
| --- | --- |
| [enums.ts](./enums.ts) | 全部 PostgreSQL 枚举类型 |
| [bytea.ts](./bytea.ts) | `bytea` 自定义列类型（Buffer 往返，用于摘要/checksum） |
| [rooms.ts](./rooms.ts) | `rooms` |
| [room-players.ts](./room-players.ts) | `room_players` |
| [tournaments.ts](./tournaments.ts) | `tournaments` |
| [hands.ts](./hands.ts) | `hands` |
| [tournament-players.ts](./tournament-players.ts) | `tournament_players` |
| [hand-events.ts](./hand-events.ts) | `hand_events` |
| [game-snapshots.ts](./game-snapshots.ts) | `game_snapshots` |
| [ai-requests.ts](./ai-requests.ts) | `ai_requests`（P1 启用，Schema 已按规格落地） |

## 约定

- 表不带 schema 前缀（目标 schema 由连接 `search_path` 决定；见 [database/](../database/README.md)）。
- CHECK 表达式使用**带引号裸列名**（PostgreSQL 表约束不接受表别名）。
- 两个循环复合外键（`rooms.host_player_id`、`tournaments.champion_tournament_player_id` 的 DEFERRABLE 版本）**不在** Drizzle 定义中，只存在于手写迁移 `0001`——TS 定义中声明会导致 drizzle-kit 生成非 DEFERRABLE 版本或后续 diff 漂移。
- `bigint` 一律 `mode: "bigint"`；`last_committed_sequence`/`forfeited_chips` 的默认值用 `sql\`0\``（drizzle-kit 无法序列化 BigInt 字面量默认值）。
