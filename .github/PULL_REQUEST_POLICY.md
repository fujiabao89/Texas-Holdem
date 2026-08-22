# Pull Request Policy

本政策适用于所有合并到 `main` 的 Pull Request。GitHub Ruleset 会强制其中可自动检查的部分；其余部分通过评审执行。

## 提交前提

1. 每项工作必须关联一个 Linear 任务。
2. Linear 任务标题使用 `[TEX-<number>] <可读摘要>`；分支名使用 `<type>/TEX-<number>-<kebab-case-summary>`。两者的 `TEX-<number>` 必须一致。
3. PR 标题必须与 Linear 任务标题完全一致，且以 `[TEX-<number>] ` 开头；不得以源分支名作为 PR 标题。PR 标题的编号必须与源分支一致，以便 Linear、分支与 PR 的一一追踪。
4. PR 描述必须包含 `Linear: TEX-<number>`；Dependabot 更新不受此项约束。
5. 一个 PR 只解决一个可审查的目标，不夹带无关格式化、重构或依赖升级。

允许的 `type`：`feat`、`fix`、`chore`、`docs`、`refactor`、`test`、`hotfix`。

## 必需检查与审阅

- `CI / repository-hygiene`、`CI / workflow-lint` 与 `PR Policy / branch-and-pr-policy` 必须通过。变更依赖清单时，`Dependency Review / dependency-review` 也必须通过。
- 每个 PR 至少需要一项批准；新的推送会使已有批准失效。
- 所有审阅线程必须解决。
- 涉及 `packages/poker-engine`、`packages/protocol`、服务端基础设施、`.github` 或 `docs` 的变更将请求相应 CODEOWNER 审阅。
- 当仓库仍只有一位维护者时，管理员可使用 Ruleset bypass 合并；必须在 PR 中说明原因，并在后续有第二位维护者时停止这种常规使用。

## 内容要求

- 说明行为变化、非范围与用户影响。
- 列出已运行的测试/检查及结果；未运行时必须说明原因和风险。
- 新增或变更公开接口、协议、数据模型、扑克规则或安全边界时，同步更新其权威规格并在 PR 中链接。
- 不提交密钥、个人数据、构建产物或与任务无关的文件。

## 合并与例外

- 使用 squash merge，合并后删除源分支。
- 禁止直接推送、删除或强制推送 `main`。
- 仅限生产事故、恢复仓库可用性等紧急情况使用管理员 bypass；事后补建 Linear 任务、PR 记录和回顾。
