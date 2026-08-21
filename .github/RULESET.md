# Main Branch Ruleset

`main` 使用 GitHub Ruleset **Main branch protection**。可审查的规则定义保存在 [`rulesets/main.json`](./rulesets/main.json)，实际规则由仓库管理员通过 GitHub API 应用。

## 强制规则

- 仅允许通过 Pull Request 合并。
- 至少一项批准，新的推送会撤销旧批准，并要求解决所有审阅线程。
- 必须通过 `CI / repository-hygiene`、`CI / workflow-lint` 与 `PR Policy / branch-and-pr-policy`。
- 禁止删除和强制推送 `main`。
- 管理员保留仅用于紧急恢复的 bypass；使用后必须留下 Linear 和 PR 记录。

分支命名不由 GitHub 原生 Ruleset 的通配符功能强制，而由 PR Policy 工作流验证，规则见 [`PULL_REQUEST_POLICY.md`](./PULL_REQUEST_POLICY.md)。
