# 真实端到端回归

真实浏览器 → `apps/web` → 生产装配 game-server → PostgreSQL 的业务流程；禁止伪造 Snapshot/Event 或直接修改数据库构造赢家。既有业务、错误和可访问性用例使用 [real 配置](../playwright.real.config.ts)，入口 `pnpm test:e2e:real`。TEX-62 时序用例由 [timeline 套件](./timeline/README.md) 独立运行，不与既有套件重复收集。

[support](./support/README.md) 提供 UI 动作、runId/schema 隔离、服务端迁移启动与退出清理。配置会写入本地 `.run-identity.json`；两个真实套件不能同时运行。环境与测试约束的权威来源是 [06](../../../docs/06-testing-strategy.md)。
