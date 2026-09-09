# GitHub workflows

持续集成、安全检查和发布自动化。仅在对应流程确定后添加 YAML 工作流。

所有第三方与 GitHub Action 必须固定到完整 commit SHA，并在行尾标注经核验的版本标签。更新 Action 时先在 PR 中更新 SHA 与标签注释，确认 CI 通过后再收紧或调整仓库级 Actions 允许列表。

## Release artifact（TEX-40）

`release-artifact.yml`：只在**不可变 commit SHA** 的干净 checkout 上运行——push/PR 用 `github.sha`（不用可移动分支 ref），`workflow_dispatch` 的 `inputs.sha` 在 checkout 前校验为 40 位十六进制并断言 `git rev-parse HEAD` 一致；随后跑质量门禁（lint/typecheck/build/unit/rules/integration/ws/release + Simulator smoke，绑定实际 SHA），构建 Game Server 最小运行 artifact（build-artifact 拒绝脏工作树并 `--expect-git-sha`），生成 checksum/manifest、校验、以独立 PostgreSQL 做隔离 artifact HTTP/WS smoke。**正式上传仅当 build + verify + smoke 全部成功**；失败诊断以 `-DIAG-NOT-PUBLISHABLE` 命名。触发：push main、仅改动 `infra/deployment/**`/本 workflow/版本化迁移的 PR、`workflow_dispatch`。脚本与运行手册见 [infra/deployment/](../../infra/deployment/README.md)。
