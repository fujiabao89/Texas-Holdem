# Trae Work 辅助工程约束

你是本项目的辅助工程 Agent。开始任何工作前，必须阅读 [AGENTS.md](./AGENTS.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)、目标 Linear 任务和相关工程规格。

## 你的授权范围

- 承担由 Codex 或用户明确分配的、边界清晰且可独立验收的工程子任务。
- 优先承担测试补齐、文档同步、基础设施配置、局部功能、缺陷修复和代码审查后的明确修改。
- 在 Claude Code 未占用的目录范围内工作。

## 协作规则

1. 开工前声明 Linear 任务、分支名及计划修改的目录/文件；若与 Claude Code 重叠，先等待 Codex 拆分或改派。
2. 使用包含同一 `TEX-<number>` 的分支名（`<type>/TEX-<number>-<kebab-case-summary>`）；Linear 任务标题和 PR 标题使用 `[TEX-<number>] <可读摘要>`，不向 `main` 提交。
3. 不自行拆分或扩大产品范围，不替换技术栈，不更改引擎、协议或持久化的公共边界。
4. 发现架构缺口时，记录证据与建议并交给 Codex；不要以临时代码绕过既定边界。
5. 交付前运行本任务要求的最小充分测试，并报告改动、验证结果、限制和冲突风险。

## 文档同步职责

1. 开工前读取目标目录 `README.md`。修改某目录的职责、测试资产、配置、运行方式或局部功能入口时，必须在同一 PR 同步该目录 README；只有稳定职责目录才创建新的 README，禁止为未来用途预建空说明文件。
2. 按事实归属写入对应文档目录：产品/任务写 `docs/00-project/` 或 `docs/01-product/`，工程与测试写 `docs/03-engineering/`，安全写 `docs/04-security/`，部署与监控写 `docs/05-operations/`。架构、协议、数据模型或规则的权威文档变更必须先交 Codex 协调。
3. 不维护平行说明或复制权威规格。发现 README、任务卡、代码或规格相互矛盾时，停止相关变更并报告冲突证据。
4. 每个任务交付时必须报告：更新了哪些文档；或已检查哪些文档且为什么无需更新。文档未同步不得标记任务完成。

## 提交与推送前的本地审查门禁

完成实现后、执行 `git add`、`git commit` 或 `git push` 前，必须调用由 [DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md](./DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md) 创建的 DeepSeek Harness 本地审查 Agent。

- 审查必须包含已暂存、未暂存和未跟踪的任务相关文件。
- 只有最终结果为 `PRE_PUSH_REVIEW: PASS` 才可暂存、提交和推送；`BLOCKED` 或 `NEEDS_DECISION` 必须先修复或交给 Codex / 用户决定，再重新审查。
- 审查 Agent 只能读取和报告，禁止让它修改实现、暂存、提交或推送。紧急豁免仅由用户明确批准，并在提交信息或 PR 中记录原因。
- 交付时报告审查结论、P0/P1/P2 的处理情况与仍存在的 P3 建议。

## Pull Request 描述要求

创建 PR 时必须使用 [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)，并将占位内容替换为当前任务的事实。

- 逐项填写问题/目标、解决方式和关键变更文件；每个文件或目录必须说明改动与原因/影响。
- 填写与分支编号一致的 `Linear: TEX-<number>`、实际验证命令及结果、审阅关注点、风险和回滚方案。
- 明确用户影响、非范围与未运行验证的原因；不得提交空表格、`待填写`、过期示例或泛泛描述。
- PR 标题必须与 Linear 任务标题完全一致，并以 `[TEX-<number>] ` 开头；其编号必须与源分支一致。PR 保持草稿，直到实现、DeepSeek Harness 审查和 PR 描述均已完成。

## 特别禁止

- 不与 Claude Code 同时修改同一个功能模块的核心文件。
- 不在 `apps/web` 重复扑克规则，不在 `apps/game-server` 复制协议 Schema。
- 不创建没有真实职责的目录、包、脚本或抽象层。
