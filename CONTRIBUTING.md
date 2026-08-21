# Contribution convention

## Default branch

`main` is the integration branch. Do not commit feature work directly to it.

## Branch and Linear task naming

The Linear issue title **must be exactly the same as its GitHub branch name**:

```
<type>/<TEAM-ISSUE>-<kebab-case-summary>
```

For this project, Linear issues belong to the `WEBDB` team, so the identifier is assigned by Linear and uses the `WEB-<number>` form. Examples:

```
feat/WEB-101-hand-history-import
fix/WEB-102-side-pot-calculation
chore/WEB-103-update-development-docs
```

Allowed branch types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `hotfix`.

Workflow:
1. Create the Linear issue in the `WEBDB` team.
2. Use its generated identifier in the branch/task title.
3. Create the matching Git branch from `main`.
4. Keep the issue title and branch name identical for the life of the work.

Use lowercase letters, digits, and hyphens in the summary; avoid spaces, underscores, and Chinese punctuation.
