# 真实端到端回归

真实浏览器 → `apps/web` → 生产装配 game-server → PostgreSQL 的业务流程；禁止伪造 Snapshot/Event 或直接修改数据库构造赢家。既有业务、错误和可访问性用例使用 [real 配置](../playwright.real.config.ts)，入口 `pnpm test:e2e:real`。TEX-62 时序用例由 [timeline 套件](./timeline/README.md) 独立运行，不与既有套件重复收集。

[support](./support/README.md) 提供 UI 动作、runId/schema 隔离、服务端迁移启动与退出清理。配置会写入本地 `.run-identity.json`；两个真实套件不能同时运行。环境与测试约束的权威来源是 [06](../../../docs/06-testing-strategy.md)。

TEX-48 更新 multiplayer-journey 与 result-recovery 的第二场步骤：旧结果入口明确被拒，显式 HTTP 重新开放后由现有 Lobby UI 全员准备并开局；保留新旧比赛隔离验收。新的结果页产品入口仍由 TEX-49 接入。

TEX-49 取代上述临时桥接：`reopenLobbyViaUi` 只点击结果页公开按钮并验证同房间大厅；多人旅程在下一轮加入第三名外部玩家、确认其未入座阻塞开局，完成 Ready 后创建新 Tournament。开局后 helper 等待自动导航到牌桌；不直接请求重开 API 或修改浏览器 store。

TEX-49 CI 后续核验：WS 字段级安全用例在双方入桌后通过 UI 弃牌推进一手，并等待双方实际收到他人脱敏 DEAL，再全下结束。至少两手的数据库事实保证非空审计不依赖大厅到牌桌重认证期间是否捕获首手发牌；原有私有键、本人底牌、逐 socket 他人 card 禁令与公开牌断言全部保留，不使用额外重试或固定延迟。
