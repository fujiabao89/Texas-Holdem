# Result feature

比赛结果页（TEX-27、TEX-55，docs/05 §6.6）：`/room/[roomId]/result/[tournamentId]` 展示单场已结束 Tournament 的服务端权威排名、冠军与各玩家最终筹码/名次。

- `result-page-content.tsx` — 页面组件：
  - 数据源优先级：首选当前内存中的终局快照（`state.game` 匹配 URL `tournamentId` 且 `tournamentStatus === "FINISHED"`）；缺失或直接访问时通过 `HttpTransport.getTournamentResult` 请求权威持久化赛果（TEX-54 端点）。
  - 缓存与多轮隔离：赛果按 `tournamentId` 缓存于组件状态，房主开启下一局比赛（`room.status` 变为 `IN_GAME`）后，旧赛果页面稳定展示，不与新比赛快照混合。
  - 请求竞态保护：基于 `AbortController` 与请求状态守卫，路由切换或卸载时取消未完成请求，迟到旧响应不覆盖当前赛果。
  - 错误与降级分支：覆盖加载中、未授权/凭证失效或缺失（跨资源的 Tournament 请求收到 AUTH_FAILED 绝不误清本地有效 Room Token，展示权限错误并引导前往牌桌/加入）、未找到（404）、未完成（409，提供回桌链接）、正在同步（503，提供重试）及房间关闭状态。
  - 房主仅在 FINISHED 通过 REOPEN_LOBBY + expectedRoomRevision 重新开放同一房间，成功后进入筹备大厅；LOBBY 显示返回入口，IN_GAME 只显示前往牌桌，不直接开赛。权限随当前 hostPlayerId 更新，旧 HTTP 响应不能覆盖更新的 RoomSnapshot。
- `result-view.ts` — 纯展示模型：
  - `resultRows`：统一适配 `GameSnapshot` 与 `TournamentResult`，按权威名次起点 `placement.from` 结合组内 `displayOrder` 稳定呈现（UI 绝不主观重排），正确呈现并列名次区间与最终筹码。
  - `resultChampion`：提取冠军信息，严格遵循 ADR-0002 支持无冠军终局（`championPlayerId: null`），不主观捏造冠军；`GameSnapshot` 路径基于唯一无争议第一名（`placement.from === 1 && placement.to === 1 && displayOrder === 1`）且 `pokerStatus === "ACTIVE"` 识别冠军，已淘汰（`ELIMINATED`）或已弃赛（`WITHDRAWN`）玩家以及并列第一时均稳定返回无冠军，两通道展示严格一致。
  - `canReopenLobby`：仅当前房主、仅 FINISHED 可重新开放；LOBBY/IN_GAME/CLOSED 均不可执行重开。

排名、名次（含并列区间）与最终筹码全部来自服务端，客户端严禁计算或重排赛果。

TEX-49：旧赛果按 URL 的 tournamentId 独立缓存/GET 恢复；同场“牌局记录”打开既有 HandHistoryDrawer，不显示新 Tournament 的本手事件。关闭快照优先于凭证清理后的缺失提示。运行与验证见 [验收记录](../../../../../docs/03-engineering/TEX-49-acceptance.md)。

PR #85 审查修复：历史入口将 `activeResult.players` 的归档昵称传给 Drawer，刷新后无实时快照、以及旧比赛玩家不在下一场时，列表赢家与详情动作/派奖仍使用该比赛的名称。
