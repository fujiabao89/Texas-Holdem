# Betting table E2E

TEX-25 的牌桌端到端测试。每个用例用 Playwright `routeWebSocket` 模拟严格协议消息，只把 `RoomSnapshot`、`GameSnapshot`、`GAME_EVENT` 和命令回执送入现有 Transport；测试不启动真实 game-server，也不把测试数据写入 URL 或日志。

覆盖键盘提交、服务端 Event 才推进画面、All-in 两步确认、房间关闭、成员被移出与 Session Replaced。更多多人断网/网络切换联调由 TEX-28 承担。

消息夹具引用共享 `PROTOCOL_VERSION`（TEX-53 起 v4），不硬编码历史 wire 版本。

TEX-26 合并 TEX-27 的定向回归同时验证音效/历史按钮、单一连接状态和牌堆、历史抽屉关闭焦点返回，以及动画未播完时 canonical 行动机会已切换的倒计时；HTTP/WS 与浏览器时钟均受控，不依赖真实 game-server 或 sleep。

TEX-60：mock 明确支持 TIME_SYNC；受控浏览器时钟覆盖 50/100/300/500ms RTT、校时前禁用、安全余量归零、迟到 Snapshot 不回跳、本地 Date 跳变不授时、Time Bank 延长与 ACTION_TIMEOUT 明确反馈/同步。单元承担非对称抖动与重连命令幂等；真实公网/大规模门禁仍属 TEX-62。运行：pnpm exec playwright test -c tests/e2e/playwright.config.ts betting --workers=1。
