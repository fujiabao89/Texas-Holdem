# Domain events

不可变的扑克领域事件，作为投影、持久化和协议映射的内部事实来源（TEX-14 手级 + TEX-15 锦标赛级）。

- `events.ts` —— `PokerEvent` 可辨识联合：HAND_STARTED / BLIND_POSTED / DEAL_HOLE_CARD / BURN_CARD(无牌面) / FLOP_DEALT / TURN_DEALT / RIVER_DEALT / PLAYER_CHECKED・CALLED・BET・RAISED・FOLDED・ALL_IN / SHOWDOWN_STARTED / PLAYER_REVEALED / UNCALLED_BET_RETURNED / POT_AWARDED / PLAYER_ELIMINATED / PLAYER_WITHDRAWN / TOURNAMENT_FINISHED。
- 每个事件带自增 `sequence`（供「非法 Action 后 sequence 不变」断言）；事件序列与状态转移严格一致。
- `BURN_CARD` **绝不携带牌面**；`DEAL_HOLE_CARD`/`PLAYER_REVEALED` 携带牌面属服务端内部权威流，客户端/AI 经 game-server 投影过滤。
- TEX-15：`PLAYER_ELIMINATED`（携带 `handNumber`/`placementRange`/`displayOrder`）、`PLAYER_WITHDRAWN`（`forfeitedChips`）、`TOURNAMENT_FINISHED`（`championSeat`/`finalStandings`）供历史/投影消费。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §14、§16。
