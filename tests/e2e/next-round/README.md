# 下一轮筹备大厅回归（TEX-49）

运行：`pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round`。

`lobby-fixture.ts` 是状态化 HTTP/WS 夹具，只经共享协议 Schema 发送消息；不访问浏览器 ProjectionStore。`next-round.spec.ts` 验证结果页重开同房间、非房主权限/房主转移、外部玩家加入/未入座/Ready、离线阻塞及踢出、revision 竞态、重复点击锁、刷新重连、邀请码四态、新场快照导航和旧赛果/历史隔离，包含 axe 严重违规扫描与大厅截图。

与 `real/` 的真实 game-server/PostgreSQL 回归互补；不把夹具响应视为服务端正确性的证据。失败诊断、截图、trace 沿用根 E2E 门禁。验收事实见 [TEX-49 记录](../../../docs/03-engineering/TEX-49-acceptance.md)。
