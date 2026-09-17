# Result feature

比赛结果页（TEX-27、TEX-55，docs/05 §6.6）：`/room/[roomId]/result/[tournamentId]` 展示单场已结束 Tournament 的服务端权威排名、冠军与各玩家最终筹码/名次。

- `result-page-content.tsx` — 页面组件：
  - 数据源优先级：首选当前内存中的终局快照（`state.game` 匹配 URL `tournamentId` 且 `tournamentStatus === "FINISHED"`）；缺失或直接访问时通过 `HttpTransport.getTournamentResult` 请求权威持久化赛果（TEX-54 端点）。
  - 缓存与多轮隔离：赛果按 `tournamentId` 缓存于组件状态，房主开启下一局比赛（`room.status` 变为 `IN_GAME`）后，旧赛果页面稳定展示，不与新比赛快照混合。
  - 请求竞态保护：基于 `AbortController` 与请求状态守卫，路由切换或卸载时取消未完成请求，迟到旧响应不覆盖当前赛果。
  - 错误与降级分支：覆盖加载中、未授权/凭证失效或缺失（跨资源的 Tournament 请求收到 AUTH_FAILED 绝不误清本地有效 Room Token，展示权限错误并引导前往牌桌/加入）、未找到（404）、未完成（409，提供回桌链接）、正在同步（503，提供重试）及房间关闭状态。
  - 房主的“再来一局”经 `startTournament` 流程创建新 Tournament，不复用旧牌局状态。
- `result-view.ts` — 纯展示模型：
  - `resultRows`：统一适配 `GameSnapshot` 与 `TournamentResult`，按权威名次起点 `placement.from` 结合组内 `displayOrder` 稳定呈现（UI 绝不主观重排），正确呈现并列名次区间与最终筹码。
  - `resultChampion`：提取冠军信息，严格遵循 ADR-0002 支持无冠军终局（`championPlayerId: null`），不主观捏造冠军；`GameSnapshot` 路径基于唯一无争议第一名（`placement.from === 1 && placement.to === 1 && displayOrder === 1`）识别冠军并排除 `WITHDRAWN` 玩家，在并列第一时稳定返回无冠军，两通道展示严格一致。
  - `canPlayAgain`：房主且房间处于 `FINISHED` 或 `LOBBY` 状态（`IN_GAME` 与 `CLOSED` 期间严格为 `false`）。

排名、名次（含并列区间）与最终筹码全部来自服务端，客户端严禁计算或重排赛果。
