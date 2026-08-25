# Betting table E2E

TEX-25 的牌桌端到端测试。每个用例用 Playwright `routeWebSocket` 模拟严格协议消息，只把 `RoomSnapshot`、`GameSnapshot`、`GAME_EVENT` 和命令回执送入现有 Transport；测试不启动真实 game-server，也不把测试数据写入 URL 或日志。

覆盖键盘提交、服务端 Event 才推进画面、All-in 两步确认、房间关闭、成员被移出与 Session Replaced。更多多人断网/网络切换联调由 TEX-28 承担。
