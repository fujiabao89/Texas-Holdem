# projection（TEX-20）

状态投影器：`PlayerView` / wire `GameEvent` / `PlayerViewPatch` 的纯函数投影。权威规格：docs/02-protocol-spec.md §9、docs/04-game-server-architecture.md §11。

- `projectPlayerView(input)` → schema 合法 `PlayerView`（02 §9.2）。内部 `GameState` 绝不直接发浏览器；未授权信息（其他玩家底牌、Deck、Burn 牌面）在服务端源头删除（红线 2）。
- `projectViewPatch(input)` → 全字段 `PlayerViewPatch`：每事件发送完整新视图，恒满足 `apply(previousView, patch) == 该事件后的服务端投影`。
- `projectWireEvent(event, ctx)` → wire `GameEvent`（02 §8.3）。Engine 事件 → wire 的关键映射：Engine Card（数值 rank/小写 suit）→ wire（字符串 rank/UPPER_SNAKE suit）；`PLAYER_RAISED` 恒为完整加注（`isFullRaise=true`，Engine 只允许完整加注进入 RAISED）；`DEAL_HOLE_CARD.card` 只对目标玩家投影；`BURN_CARD` 永不携带牌面。

在 `PLAYER_REVEALED` 中，投影器使用服务端 `evaluateHand` 的 `bestFiveCards` 输出 `handRank.bestFiveCards`；它与牌型标签同属已公开 Showdown 投影，Web 端不得重算。

TEX-36：`TOURNAMENT_FINISHED` 将 Engine 的 `championSeat: null` 明确投影为 `winnerPlayerId: null`，包括空排名的终局，遵循共享 wire v3 契约；不使用空 ID 或虚构冠军。定向验证：`pnpm exec vitest run --project unit apps/game-server/src/projection/state-projector.test.ts`。

逐接收者投影由执行器按 `viewerPlayerId` 组装；`DEAL_HOLE_CARD` 对非目标接收者删除 `card` 字段但保留公开的座位/发牌事实，事件 `type/tournamentId/sequence/handId` 一致（02 §9.4）。

TEX-53：完整视图与逐事件 patch 的 D/SB/BB 读取当前 hand，SB/BB 无手为 null，保留手末座位直至下一手。执行器在替换 `handId` 前发完旧手尾部事件，下一手 `HAND_STARTED` 才携带新的 handId 与 D/SB/BB，避免撤回结算时提前推进客户端牌桌。`blind-seats.test.ts` 覆盖 2/3/6/10 人、空位、撤回、真实全下淘汰、跨手与恢复；规则与 nullable 语义仅在 [协议规格](../../../../docs/02-protocol-spec.md) §9.2 维护。
