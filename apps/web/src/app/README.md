# App entry and routing

唯一的前端路由、Provider 与应用启动入口。不得再引入并行的 `pages` 路由体系。

TEX-23 提供 `/`、`/create`、`/join`、`/settings`、`/room/[roomId]`、`/room/[roomId]/table` 和 `/room/[roomId]/result/[tournamentId]` 的路由壳。TEX-24 实现创建/加入/Lobby；TEX-25 实现 `/room/[roomId]/table`，该路由仅组合 `features/poker-table/`，不接入第二套 WebSocket 或投影缓存。全局样式还只定义 TEX-26 的 transform/opacity 手牌、公共牌、翻牌和摊牌组合关键帧：牌堆位于牌桌外左上角白色留白区，每张手牌都由独立 Event 展示实例从其实测中心沿浅弧线飞向座位，最后一张在落地边界原子交接给 Seat，避免飞行牌背覆盖翻面；两轮全部完成后本人两张牌再依次纵轴翻开。公共牌按“飞入 → 停顿 → 翻面”逐张可读地播放，Showdown 保留候选牌淡出与 Best Five 组合停留。Reduced Motion 下这些关键帧不运行，队列立即提交终态。赛果和设置页仍为后续任务范围。
