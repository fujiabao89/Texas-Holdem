# GitHub workflows

持续集成、安全检查和发布自动化。仅在对应流程确定后添加 YAML 工作流。

所有第三方与 GitHub Action 必须固定到完整 commit SHA，并在行尾标注经核验的版本标签。更新 Action 时先在 PR 中更新 SHA 与标签注释，确认 CI 通过后再收紧或调整仓库级 Actions 允许列表。

`ci.yml` 的 `perf-smoke` 无论成功或失败都上传 `tests/performance/.artifacts` 的脱敏 JSON，显式包含该隐藏目录。功能计数也写入 job 日志；判定与产物边界见 [压测说明](../../tests/performance/README.md)。

TEX-62：`ci.yml` 的 `e2e-timeline` 运行真实 PostgreSQL 时序 PR 子集（9 项，Chromium 全量、Firefox/WebKit 关键流程），成功或失败均上传脱敏证据，保留 7 天。[timeline.yml](./timeline.yml) 手动接收完整候选 SHA，在同一提交运行 RC 矩阵（20 项，独立 schema/进程、零重试）；真实后台测试使用 Xvfb 有界桌面。RC 产物在 GitHub 保留 90 天，发布负责人须按 [06 §10.2](../../docs/06-testing-strategy.md#102-监控验收工程基线) 转存受控 Release 档案至 180 天；GitHub 短期保留不替代发布档案。运行说明见 [时序套件](../../tests/e2e/real/timeline/README.md)。仓库 required checks 的外部设置由用户决定。

## PR 风险观察器（TEX-64）

[`ai-pr-router.yml`](./ai-pr-router.yml) 监听现有 `CI` 的 PR 开始/完成事件，并提供维护者手动刷新入口。它拉取固定 SHA 的可信工具源码，通过 GitHub API 读取 PR 并更新单条风险报告；不执行被审 PR 的代码，不改变现有 required checks。配置位于 [`.ai-router/`](../../.ai-router/README.md)，Secret、授权、恢复与 TEX-61 试用步骤见 [接入说明](../../docs/03-engineering/ai-pr-router-observer.md)。自动入口在此配置 PR 合入默认分支后生效。
