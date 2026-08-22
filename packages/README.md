# Shared packages

跨应用共享且可独立测试、发布或复用的包。每个包必须有清晰所有权和单一事实来源。

当前（TEX-11）尚未创建任何共享包；以下为《德州扑克项目总规划》§6 规划的包，将在后续任务落地：

- `packages/poker-engine` — 纯扑克规则（唯一归属，不得依赖网络、数据库、UI 或框架）。
- `packages/protocol` — 通信 Schema 与推导类型（前后端唯一事实来源，不维护平行 DTO）。
- `packages/poker-math` — P1 的确定性计算（Equity、Pot Odds、Position 等）。
- `packages/shared` — 跨应用共享工具。
