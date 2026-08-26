# projection（TEX-20）

状态投影器：`PlayerView` / wire `GameEvent` / `PlayerViewPatch` 的纯函数投影。权威规格：docs/02-protocol-spec.md §9、docs/04-game-server-architecture.md §11。

- `projectPlayerView(input)` → schema 合法 `PlayerView`（02 §9.2）。内部 `GameState` 绝不直接发浏览器；未授权信息（其他玩家底牌、Deck、Burn 牌面）在服务端源头删除（红线 2）。
- `projectViewPatch(input)` → 全字段 `PlayerViewPatch`：每事件发送完整新视图，恒满足 `apply(previousView, patch) == 该事件后的服务端投影`。
- `projectWireEvent(event, ctx)` → wire `GameEvent`（02 §8.3）。Engine 事件 → wire 的关键映射：Engine Card（数值 rank/小写 suit）→ wire（字符串 rank/UPPER_SNAKE suit）；`PLAYER_RAISED` 恒为完整加注（`isFullRaise=true`，Engine 只允许完整加注进入 RAISED）；`DEAL_HOLE_CARD.card` 只对目标玩家投影；`BURN_CARD` 永不携带牌面。

在 `PLAYER_REVEALED` 中，投影器使用服务端 `evaluateHand` 的 `bestFiveCards` 输出 `handRank.bestFiveCards`；它与牌型标签同属已公开 Showdown 投影，Web 端不得重算。

逐接收者投影由执行器按 `viewerPlayerId` 组装；`DEAL_HOLE_CARD` 对非目标接收者删除 `card` 字段但保留公开的座位/发牌事实，事件 `type/tournamentId/sequence/handId` 一致（02 §9.4）。
