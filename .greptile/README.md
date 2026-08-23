# Greptile review configuration

Greptile uses this directory-scoped configuration rather than the legacy root `greptile.json`. The files cascade to future child `.greptile/` directories, allowing each package to add stricter local rules without duplicating repository-wide policy.

- `config.json` contains machine-readable behavior and scoped high-risk rules.
- `rules.md` explains the project review priorities in plain language.
- `files.json` names the repository documents that provide review context.

自动审查已关闭：`config.json` 的 `skipReview: "AUTOMATIC"` 阻止 Greptile 在 PR 创建或更新时自动审查，`triggerOnUpdates: false` 禁止推送新提交后重新审查。仅由用户在目标 PR 中手动评论 `@greptileai` 触发审查。

Update these files together with `AGENTS.md`, `CONTRIBUTING.md`, or architecture specifications when their review-relevant requirements change.
