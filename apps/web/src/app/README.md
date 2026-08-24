# App entry and routing

唯一的前端路由、Provider 与应用启动入口。不得再引入并行的 `pages` 路由体系。

TEX-23 提供 `/`、`/create`、`/join`、`/settings`、`/room/[roomId]`、`/room/[roomId]/table` 和 `/room/[roomId]/result/[tournamentId]` 的最小壳。除首页的创建/加入入口外，其他路由只显示中性壳；业务表单与牌桌 UI 留给 TEX-24+。
