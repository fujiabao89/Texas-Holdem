# GitHub workflows

持续集成、安全检查和发布自动化。仅在对应流程确定后添加 YAML 工作流。

所有第三方与 GitHub Action 必须固定到完整 commit SHA，并在行尾标注经核验的版本标签。更新 Action 时先在 PR 中更新 SHA 与标签注释，确认 CI 通过后再收紧或调整仓库级 Actions 允许列表。

`ci.yml` 的 `perf-smoke` 无论成功或失败都上传 `tests/performance/.artifacts` 的脱敏 JSON，显式包含该隐藏目录。功能计数也写入 job 日志；判定与产物边界见 [压测说明](../../tests/performance/README.md)。

TEX-62：`ci.yml` 的 `e2e-timeline` 运行真实 PostgreSQL 时序 PR 子集（9 项，Chromium 全量、Firefox/WebKit 关键流程），成功或失败均上传脱敏证据，保留 7 天。[timeline.yml](./timeline.yml) 手动接收完整候选 SHA，在同一提交运行 RC 矩阵（20 项，独立 schema/进程、零重试）；真实后台测试使用 Xvfb 有界桌面。RC 产物在 GitHub 保留 90 天，发布负责人须按 [06 §10.2](../../docs/06-testing-strategy.md#102-监控验收工程基线) 转存受控 Release 档案至 180 天；GitHub 短期保留不替代发布档案。运行说明见 [时序套件](../../tests/e2e/real/timeline/README.md)。仓库 required checks 的外部设置由用户决定。

## PR 风险观察器（TEX-64）

[`ai-pr-router.yml`](./ai-pr-router.yml) 监听现有 `CI` 的 PR 开始/完成事件，并提供维护者手动刷新入口。它拉取固定 SHA 的可信工具源码，通过 GitHub API 读取 PR 并更新单条风险报告；不执行被审 PR 的代码，不改变现有 required checks。配置位于 [`.ai-router/`](../../.ai-router/README.md)，Secret、授权、恢复与 TEX-61 试用步骤见 [接入说明](../../docs/03-engineering/ai-pr-router-observer.md)。自动入口在此配置 PR 合入默认分支后生效。

首次接入的 RC Workflow 尚未出现在 main 时，可以给 TEX-62 PR 添加 `timeline-rc` 标签，在该 PR 的完整 head SHA 上启动同一 20 项门禁（Linux/Xvfb，零重试）；不依赖先合并 Workflow。此入口只用 contents:read 与隔离测试数据库，无生产秘密。PR head 更新会重新运行；日常 9 项 PR 门禁仍由 CI 的 main 目标 PR 执行，依赖分支合并后应依次调整 PR base。
带 `timeline-rc` 的 PR 不受改动路径限制，应用、协议或服务端代码变更也会运行 RC；只有添加 `timeline-rc` 本身的标签事件启动作业，添加其他标签不重跑。并发控制位于 job 级：按 PR 编号/手工 ref 串行并取消被替代的候选作业，跳过的 job 不会取消正在运行的 RC；测试本身仍为零重试。

RC 产物名称包含实际完整候选 SHA（手动输入或 PR head）。时序配置显式关闭 Playwright 自动 Git 元数据/source diff 捕获，避免 CI diff 将环境连接串带入报告；SHA/dirty 来源由 gate.json 与各场景证据独立记录。上传前审计继续拒绝敏感产物，不通过删除失败或跳过审计放行。
