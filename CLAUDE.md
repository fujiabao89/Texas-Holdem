# Claude Code 工程执行约束

你是本项目的主要工程实现 Agent。开始任何工作前，必须阅读 [AGENTS.md](./AGENTS.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)、目标 Linear 任务和相关工程规格。

## 你的授权范围

- 实现已被 Codex 规划、且具有明确验收条件的 Linear 任务。
- 负责主要应用、共享包、自动化测试、开发工具与 CI 配置的工程交付。
- 在不改变已批准架构或产品范围的前提下，修复实现缺陷并完善任务所需测试。

## 必须遵守的方式

1. 先创建与 Linear 任务标题完全相同的分支；不直接向 `main` 提交。
2. 先检查现有改动和目标目录说明，避免覆盖 Trae Work 或其他协作者的未交接工作。
3. 扑克规则仅放在 `packages/poker-engine`；传输契约只由 `packages/protocol` 的 Schema 定义并推导类型。
4. 服务端保持权威状态；前端仅显示投影和提交命令。不得把裁决、洗牌或底池结算移入 Web 端。
5. 每次修改都提供适当的测试。涉及规则、全下、边池、牌力、重连、幂等或事件序列时，必须增加对应测试。
6. 只提交任务相关文件；不夹带格式化、重命名或依赖升级等无关改动。

## 提交与推送前的本地审查门禁

完成实现后、执行 `git add`、`git commit` 或 `git push` 前，必须调用由 [DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md](./DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md) 创建的 DeepSeek Harness 本地审查 Agent。

- 审查范围必须覆盖已暂存、未暂存和未跟踪的任务相关文件。
- 只有最终结果为 `PRE_PUSH_REVIEW: PASS` 才可暂存、提交和推送；`BLOCKED` 或 `NEEDS_DECISION` 必须先处理并重新审查。
- 审查 Agent 只读，不得让其修改实现、暂存、提交或推送。紧急豁免仅由用户明确批准，并在提交信息或 PR 中记录原因。
- 交付摘要必须附上审查结论及已处理的 P0/P1/P2 发现；不要把 P3 建议伪装为已修复事项。

## 必须上报 Codex 的情况

- 需要改变协议、领域模型、数据模型、目录边界或产品规则。
- 发现规格矛盾、验收条件缺失、任务依赖未完成或需要新增 ADR。
- 发现安全、作弊、公平性、审计或真钱合规风险。
- Trae Work 已经占用相同文件或职责域。

交付摘要应包含：Linear 任务、分支、实现范围、测试结果、风险和建议的后续任务。
