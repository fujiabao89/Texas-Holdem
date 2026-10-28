# 下一轮筹备大厅回归（TEX-49）

运行：`pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round`。

`lobby-fixture.ts` 是状态化 HTTP/WS 夹具，只经共享协议 Schema 发送消息；不访问浏览器 ProjectionStore。`next-round.spec.ts` 验证结果页重开同房间、非房主权限/房主转移、外部玩家加入/未入座/Ready、离线阻塞及踢出、revision 竞态、重复点击锁、刷新重连、邀请码四态、新场快照导航和旧赛果/历史隔离，包含 axe 严重违规扫描与大厅截图。

与 `real/` 的真实 game-server/PostgreSQL 回归互补；不把夹具响应视为服务端正确性的证据。失败诊断、截图、trace 沿用根 E2E 门禁。验收事实见 [TEX-49 记录](../../../docs/03-engineering/TEX-49-acceptance.md)。

CI 回归补充：开局仅提供新 RoomSnapshot、不广播 GameSnapshot 时，页面必须主动重新认证恢复新场快照并进入牌桌；断言连接次数为大厅初次认证、新场恢复一次、牌桌挂载一次，恢复前不会出现弃牌按钮。真实时序门禁仍使用未放宽的 R1/R4 同手同序列闭合→开放断言。

PR #85 审查回归补充非空历史列表/详情：刷新且 gameSnapshot=null、下一场缺席旧玩家、同 ID 下一场改名时，均验证归档赢家/动作/派奖昵称，不出现 playerId 或下一场昵称。重开重复提交用例使用 expect.poll 等待请求真正进入 route 回调，再释放挂起请求；按钮 pending 不替代网络到达屏障。
