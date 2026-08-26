# App entry and routing

唯一的前端路由、Provider 与应用启动入口。不得再引入并行的 `pages` 路由体系。

TEX-23 提供 `/`、`/create`、`/join`、`/settings`、`/room/[roomId]`、`/room/[roomId]/table` 和 `/room/[roomId]/result/[tournamentId]` 的路由壳。TEX-24 实现创建/加入/Lobby；TEX-25 实现 `/room/[roomId]/table`，该路由仅组合 `features/poker-table/`，不接入第二套 WebSocket 或投影缓存。赛果和设置页仍为后续任务范围。
