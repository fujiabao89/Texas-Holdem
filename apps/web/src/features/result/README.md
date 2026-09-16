# Result feature

比赛结果页（TEX-27、TEX-55，docs/05 §6.6）：`/room/[roomId]/result/[tournamentId]` 展示单场已结束 Tournament 的服务端权威排名、冠军与各玩家最终筹码/名次。

- `result-page-content.tsx` — 页面组件：
  - 数据源优先级：首选当前内存中的终局快照（`state.game` 匹配 URL `tournamentId` 且 `tournamentStatus === "FINISHED"`）；缺失或直接访问时通过 `HttpTransport.getTournamentResult` 请求权威持久化赛果（TEX-54 端点）。
  - 缓存与多轮隔离：赛果按 `tournamentId` 缓存于组件状态，房主开启下一局比赛（`room.status` 变为 `IN_GAME`）后，旧赛果页面稳定展示，不与新比赛快照混合。
  - 请求竞态保护：基于 `AbortController` 与请求状态守卫，路由切换或卸载时取消未完成请求，迟到旧响应不覆盖当前赛果。
  - 错误与降级分支：覆盖加载中、未授权/凭证失效（清除被拒 Token 并引导加入）、未找到（404）、未完成（409，提供回桌链接）、正在同步（503，提供重试）及房间关闭状态。
  - 房主的“再来一局”经 `startTournament` 流程创建新 Tournament，不复用旧牌局状态。
- `result-view.ts` — 纯展示模型：
  - `resultRows`：统一适配 `GameSnapshot` 与 `TournamentResult`，按服务端 `displayOrder` 排行（UI 永不重排序），映射各玩家名次区间（含并列）与最终筹码。
  - `resultChampion`：提取冠军信息，严格遵循 ADR-0002 支持无冠军终局（`championPlayerId: null`），不主观推断冠军。
  - `canPlayAgain`：房主且房间未 CLOSED 条件。

排名、名次（含并列区间）与最终筹码全部来自服务端，客户端严禁计算或重排赛果。
