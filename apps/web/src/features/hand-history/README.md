# Hand history feature

当前玩家视角的牌局历史（TEX-27，docs/05 §13）：牌桌页"牌局记录"入口打开的右侧 Drawer（移动端全屏 Sheet），只读、打开/关闭不改变牌局状态或动画队列。

- `hand-history-drawer.tsx` — 列表/详情 Drawer：`GET /api/v1/tournaments/{tournamentId}/hands` 的 cursor 分页（每页 20，滚动到底加载下一页），顶部只读渲染 `ProjectionStore.currentHandEvents` 暂存的"本手进行中"事件；加载失败保留牌桌并提供局部重试，不使用全局 Error Boundary。
- `hand-history-model.ts` — 列表与详情的纯 reducer（加载/分页/失败状态），详情响应带 handId 防陈旧保护。
- `hand-timeline.ts` — 把服务端投影事件分组为 Pre-Flop/Flop/Turn/River/Showdown/Result 时间线的纯函数；过滤 Burn 牌与纯阶段标记，DEAL_HOLE 条目永不携带牌面值。

TEX-36 读取对接：跳过 `handId: null` 的手间前导事件，保留本手正常的撤回 Result 条目；wire v3 的无冠军终局显示“比赛结束，无冠军”。`hand-timeline.test.ts` 覆盖 wire/暂存两种来源、手间归属与 null 冠军，语义见协议 §4.2 / §8.3。

数据只来自服务端按 `playerToken` 投影的列表/详情端点与已应用的 `GAME_EVENT`；原始事件、sequence、内部 ID、Burn 牌面与他人未公开底牌不进入 UI。本目录不推导规则、不缓存跨会话历史、不提供 Replay 或外部观战。

合并 TEX-26 后，时间线测试夹具复用共享 `PROTOCOL_VERSION`，公开摊牌与分池牌型包含服务端 `bestFiveCards`；候选牌与最佳五张保持一致，不在历史模块新增选牌或牌型计算。
