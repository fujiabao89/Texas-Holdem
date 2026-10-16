# Test entrypoint meta tests

守护测试基础设施自身的结构性自测（unit 层，`pnpm test:unit`）：

- 根 `package.json` 定义 `test` / `test:unit` / `test:rules` / `test:integration` / `test:ws` / `test:e2e` / `test:sim` 全部入口；
- 根 `vitest.config.ts` 恰好定义 unit/rules/integration/ws 四层，且 include 模式互斥（同一测试文件不会被两层重复执行）；
- E2E 与 Simulator 入口文件存在。
- TEX-62 的真实时序 PR/RC 入口存在、与既有 real 套件互斥、禁用重试/原始 trace，并由执行器校验完整报告；负例在 `tests/support/timeline-evidence.test.ts` 验证少跑、跳过和重试通过不能放行。

入口被误删或层间出现重复收集时，这里的测试会先于 CI 失败。
