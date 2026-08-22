# Contribution convention

## Default branch

`main` is the integration branch. Do not commit feature work directly to it.

## Linear、branch 与 Pull Request 命名

Linear 通过标题开头的任务编号识别关联。Linear 任务标题与 GitHub PR 标题都必须使用：

```
[TEX-<number>] <可读摘要>
```

例如：

```
[TEX-52] Health Check 文档板块：快速启动 P1 + 状态文档与配置模板校准
```

Git 分支保持适合 Git 的 kebab-case 格式：

```
<type>/TEX-<number>-<kebab-case-summary>
```

例如：

```
feat/TEX-1-hand-history-import
fix/TEX-2-side-pot-calculation
chore/TEX-3-update-development-docs
```

Allowed branch types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `hotfix`.

Workflow:
1. Create the Linear issue in the `Texas Hold'em` team.
2. Use its generated `TEX-<number>` in both the Linear title and the branch name.
3. Set the PR title to exactly match the Linear title; do not use the branch name as the PR title.
4. Create the matching Git branch from `main`.
5. Keep the same `TEX-<number>` in the Linear task, branch, PR title and PR body for the life of the work.

Use lowercase letters, digits and hyphens in the **branch** summary. The Linear/PR title summary is human-readable and may use spaces and Chinese punctuation.

## Work tracking and public feedback

Linear is the only work-tracking system for this repository. GitHub Issues are disabled to avoid duplicate work items; create product work, defects, chores and planning tasks in the `Texas Hold'em` Linear team.

Do not use Linear, GitHub Issues, pull requests or public discussions to disclose vulnerabilities. Follow [SECURITY.md](./SECURITY.md) and use GitHub Private Vulnerability Reporting instead.
