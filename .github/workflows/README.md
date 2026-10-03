# GitHub workflows

持续集成、安全检查和发布自动化。仅在对应流程确定后添加 YAML 工作流。

所有第三方与 GitHub Action 必须固定到完整 commit SHA，并在行尾标注经核验的版本标签。更新 Action 时先在 PR 中更新 SHA 与标签注释，确认 CI 通过后再收紧或调整仓库级 Actions 允许列表。

## PR 风险观察器（TEX-64）

[`ai-pr-router.yml`](./ai-pr-router.yml) 监听现有 `CI` 的 PR 开始/完成事件，并提供维护者手动刷新入口。它拉取固定 SHA 的可信工具源码，通过 GitHub API 读取 PR 并更新单条风险报告；不执行被审 PR 的代码，不改变现有 required checks。配置位于 [`.ai-router/`](../../.ai-router/README.md)，Secret、授权、恢复与 TEX-61 试用步骤见 [接入说明](../../docs/03-engineering/ai-pr-router-observer.md)。自动入口在此配置 PR 合入默认分支后生效。
