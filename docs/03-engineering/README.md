# Engineering documents

开发流程、编码约定、测试策略、错误处理和可观测性规范。

多 Agent 的共同协作规范以仓库根目录的 [AGENTS.md](../../AGENTS.md) 为权威来源；各角色入口见 `CLAUDE.md`、`TRAE.md` 与 `CODEX.md`。

## 索引

- [monorepo-and-quality-baseline.md](./monorepo-and-quality-baseline.md)：pnpm monorepo、Turborepo、TypeScript、ESLint、Prettier、环境变量样例与质量命令说明。
- [pull-request-and-linear-naming.md](./pull-request-and-linear-naming.md)：Linear、分支与 GitHub Pull Request 的编号和标题关联规则。
- [TEX-25-findings-ledger.md](./TEX-25-findings-ledger.md)：PR #27 的 Codex、CodeRabbit 与 Greptile 审查意见逐项核验、严重性与处置记录。
- [TEX-26-findings-ledger.md](./TEX-26-findings-ledger.md)：TEX-26 PR 的审查意见逐项核验、main/TEX-27 合并冲突与验证处置记录。
- [TEX-28-findings-ledger.md](./TEX-28-findings-ledger.md)：TEX-28 联调 E2E/安全测试工程执行中发现并处置的生产缺陷与修复记录（F-1~F-7）。

处理 GitHub Pull Request 审查意见时，须按 `AGENTS.md` 的“Pull Request 审查意见闭环”要求：完成修改、验证、提交并推送后，在对应的原始审查评论线程回复 `已修正`。

DeepSeek Harness 审查由用户手动启动；工程 Agent 不自行调用它。用户提供审查结果后，按上述 PR 审查意见闭环处理。
