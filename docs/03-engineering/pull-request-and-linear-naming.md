# Linear、分支与 Pull Request 命名

> 状态：已实现
> 权威执行规则：[CONTRIBUTING.md](../../CONTRIBUTING.md) 与 [.github/PULL_REQUEST_POLICY.md](../../.github/PULL_REQUEST_POLICY.md)

Linear 通过标题起始位置的任务编号识别 GitHub Pull Request。每项工作使用同一个 `TEX-<number>`，但 Linear/PR 标题与 Git 分支采用不同格式：

| 对象 | 格式 | 示例 |
| --- | --- | --- |
| Linear 任务标题 | `[TEX-<number>] <可读摘要>` | `[TEX-52] Health Check 文档板块：快速启动 P1 + 状态文档与配置模板校准` |
| GitHub PR 标题 | 与 Linear 任务标题完全一致 | `[TEX-52] Health Check 文档板块：快速启动 P1 + 状态文档与配置模板校准` |
| Git 分支 | `<type>/TEX-<number>-<kebab-case-summary>` | `docs/TEX-52-health-check-docs` |
| PR 描述 | 包含 `Linear: TEX-<number>` | `Linear: TEX-52` |

GitHub 的 PR Policy 工作流会验证分支格式、PR 标题起始编号与分支编号一致，以及 PR 描述包含对应的 Linear 编号。工作流无法读取 Linear 任务正文，因此“PR 标题与 Linear 任务标题全文一致”由创建者和评审共同确认。
