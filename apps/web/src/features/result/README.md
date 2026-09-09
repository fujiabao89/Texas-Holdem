# Result feature

比赛结果页（TEX-27，docs/05 §6.6）：`/room/[roomId]/result/[tournamentId]` 展示单场已结束 Tournament 的服务端权威排名、冠军与各玩家最终筹码/名次。

- `result-page-content.tsx` — 页面组件：仅当投影中的 `game.tournamentId` 与 URL 一致且 `tournamentStatus === "FINISHED"` 时展示；房间 `CLOSED` 时展示房间已关闭；房主的"再来一局"仅经既有 `startTournament` 权威流程创建新 Tournament 并接受新快照，不复用旧牌局状态。
- `result-view.ts` — 纯展示模型：`resultRows` 按服务端 `displayOrder` 排行（UI 不重排序）、`resultAvailableFor` 的 FINISHED 门禁与 `canPlayAgain` 的房主/非 CLOSED 条件。

排名、名次（含并列区间）与最终筹码全部来自服务端投影快照，客户端不计算赛果。

TEX-44 使用深绿冠军区和暖白排名表，手机下保留可读数值与导航；仅改变视觉样式，排名和再来一局仍消费既有服务端数据与接口。
