# PR 风险观察配置

`router.config.json` 定义德州扑克路径风险下限；`jev.questions.json` 定义四个 Choice 判断问题。由 [Observer workflow](../.github/workflows/ai-pr-router.yml) 使用当前 PR 目标分支的固定版本读取，PR 对策略的修改在合入前不生效。

观察器只输出风险和审查建议；保留现有 CI、CodeRabbit、人工合并、用户手动 Greptile 和 DeepSeek Harness 流程。external_model.enabled=true 表示本项目明确允许符合作者/维护者权限要求的 PR 内容发送到 TypeSafe。密钥仅由仓库 Secret 注入。

接入、风险规则、外发授权、Secret、TEX-61 试用和恢复步骤的权威说明见 [AI PR Router 观察器接入](../docs/03-engineering/ai-pr-router-observer.md)。

验证：JSON 严格解码、workflow-lint，以及独立 AI PR Router 项目的 `npm run verify`；合入 `main` 后以真实 PR 验证触发和绑定 SHA 的单条评论。
