# AI PR Router V0.1 观察器接入（TEX-64）

日期：2026-10-03。初次接入任务：[TEX-64](https://linear.app/texas-holdem/issue/TEX-64)，已通过 PR #70 合入 `main`；TEX-61 的实际试用 PR 为 #71。可读报告升级由 [TEX-65](https://linear.app/texas-holdem/issue/TEX-65) 的独立配置 PR 交付，升级合入 `main` 后再普通刷新；不能以本地模板预览代替新版真实运行。

## 1. 运行范围

[`ai-pr-router.yml`](../../.github/workflows/ai-pr-router.yml) 监听现有工作流 `CI` 的 `workflow_run`（in_progress/completed），只处理源事件为 `pull_request` 的任务；也支持维护者从 `main` 发起 `workflow_dispatch`。报告由 GitHub Actions 机器人在目标 PR 的单条汇总评论中更新，同时出现在运行摘要。

报告仅提供路径风险、Jev 有限选项判断和审查建议。`merge_readiness=NOT_EVALUATED`、CI 状态为 `NOT_COLLECTED`、`human_approval_required=true`。不改变既有 CI/required checks，不触发、关闭或回复原审查线程，不合并、不修改业务代码、不重试 CI。Greptile、DeepSeek Harness 保持用户手动启动，治理以 [AGENTS.md](../../AGENTS.md) 为准。

观察器与现有 CI 并行，不表示 CI 已成功。CI 完成事件用于复查状态与复用判断；旧提交的报告不能作为新提交的结论。只修改 PR 标题/正文或目标分支而未产生新 CI run 时，维护者需手动刷新，不承诺持续实时监测。

## 2. 固定工具版本与可信策略

当前工具仓库为私有的 `fujiabao89/ai-pr-router-sandbox`。Workflow 使用 `ROUTER_SOURCE_TOKEN` 拉取固定提交 `be27e84f0653e5cf9ca8014373d31951416d4d91` 到临时 runner 的 `.router-tool/`，再运行本地 composite Action。该版本仅更新可读报告及旧/新模板过期提示；风险策略、JSON/ledger 和模型预算不变。只拉取可信工具，不 checkout、安装或执行被审 PR 的代码，不读取 CI artifact 作为指令。

checkout 固定到 `3d3c42e5aac5ba805825da76410c181273ba90b1`（v7，与既有 CI 一致），`persist-credentials=false`。工具自身以锁定依赖编译，Action 使用 Node 24；其 setup-node 已固定在工具提交内。目标应用的 Node/pnpm 版本与依赖不变。当前 Actions 允许列表支持 GitHub 官方 Action 和本地 Action；未来改用公开工具的远程 `uses:` 时，应加入具体工具仓库/版本，不能为方便安装开放全部第三方 Action。

[`router.config.json`](../../.ai-router/router.config.json) 与 [`jev.questions.json`](../../.ai-router/jev.questions.json) 通过 API 从 PR 目标分支固定提交读取。PR 修改这些文件不会在自身评估中生效。模型、配置、问题、上下文、head/base 与工具版本参与快照标识。

## 3. Secret 与模型外发授权

目标仓库已配置 `ROUTER_SOURCE_TOKEN`、`TYPESAFE_API_KEY`；接入准备仅核验名称存在，不能据此确认值、权限和有效期正确。首次实际运行仍需验证其可用性。

| Secret | 用途与权限 |
| --- | --- |
| `ROUTER_SOURCE_TOKEN` | 只读取私有工具仓库；fine-grained token 仅选择工具仓库、Contents Read-only，保留必要 Metadata 读取 |
| `TYPESAFE_API_KEY` | 调用 TypeSafe Jev，四个 Choice 问题在一次请求中发送；不写入源码/报告 |
| 自动 `github.token` | 读取目标仓库 PR/run 与更新评论；Workflow 权限为 contents/read、actions/read、pull-requests/write |

配置显式启用 `external_model.enabled` 与 `judge.enabled`。自动外发只限同仓库且作者经 API 验证有 write/maintain/admin 权限的 PR；fork、Dependabot 或权限不足作者不因代码公开就获得模型请求预算。维护者可人工授权当前完整 SHA，但仍受仓库配置外发开关约束。

模型接收有界、脱敏后的 PR 元数据与必要 Diff。敏感路径包括根目录和嵌套 `.env`/`.env.*`、key/pem、credentials/secrets；敏感内容移除、缺 patch、裁剪或低置信均要求复核。正则脱敏不能保证识别全部秘密。公共报告与隐藏 ledger 只保存规范化分类、路径、SHA、判断概率/usage 和状态；不保存原 Diff、完整请求、密钥或真实漏洞细节。没有自动上传 artifact 或项目遥测。

密钥更新在目标仓库 Secret 中完成；不提交本机凭证文件。只测试规则时将两个开关设为 false，并通过配置 PR 交付；模型关闭不消除读取私有工具所需的 Secret。

## 4. 德州扑克风险下限

路径规则取最大下限，Jev 可信 YES 可以升级，NO 不降低下限。普通 Markdown、测试文件和目录 README 不视为正确性证明。

| 路径范围 | 起始风险/下限 |
| --- | --- |
| `docs/guides/**` 全部变更均被允许且无其他更高规则 | LOW |
| 一般前端、根 README 与未识别路径 | MEDIUM |
| `packages/poker-engine/**`、`packages/protocol/**`、`apps/game-server/**` | HIGH |
| 认证、私密投影、随机源、数据库迁移/schema | CRITICAL |
| 权威工程规格、架构/ADR、部署与运维 | HIGH |
| 审查策略、Workflow、Agent 约束、安全说明 | CRITICAL |

精确路径和审查能力以 JSON 策略为唯一执行事实。`standard`、`deep`、`security` 只是建议能力，不对应自动启动具体机器人。已经命中 CRITICAL 且全部审查建议确定时，工具可显示 `RULES_ONLY / SKIPPED_RULE_SUFFICIENT` 并节省 Jev 请求；不表示模型已审查。

### 如何阅读新版报告

正文先说明本次结论、已知影响等级及路径依据、模型是否参与、下一步和材料限制；技术枚举、完整提交 SHA、策略版本、原始诊断和模型概率保留在折叠详情。`CRITICAL` 翻译为“需重点审查”，不代表发现漏洞。`NEEDS_VERIFICATION` 显示“需要人工复核，当前判断不完整”；脱敏、文件 Diff 过长和总上下文裁剪分别说明。`STATE_TRUNCATED` 指判断材料裁剪，不表示持久 ledger 损坏。

模型未请求、按规则跳过、已有/复用判断、请求失败和请求结果不确定分别描述；工作流绿色不表示代码通过审查。正文给出的常规/深入/安全审查是建议，没有读取已有审查意见、验证修复闭环或启动外部审查器。过期和关闭报告有醒目提示；沿用原机器人评论与隐藏 ledger，模板升级不需要人工重建。

## 5. TEX-61 PR 试用与验收

先确认 TEX-64 配置已合入 `main`，再等待 TEX-61 的开发与提交完成，并保留其 PR 打开。这里填写实际 PR number，不是 Linear 编号 61。

1. 打开 [Texas-Holdem 的 Observer Actions 页面](https://github.com/fujiabao89/Texas-Holdem/actions/workflows/ai-pr-router.yml)，选择 Run workflow、分支 `main`。
2. `pr_number` 填 TEX-61 实际 PR 编号。同仓库且作者有维护权限时其余项留空；fork 或权限不足作者需由维护者填写当前完整 `approve_model_for_sha`。
3. `rerun_reason` 默认留空，`rebuild_state` 默认 false；前者与 exact SHA 一起使用会创建新 attempt，可能重复收费，不用于普通刷新。
4. 查看任务运行摘要和 PR 的 AI PR Router 汇总评论；核对完整 HEAD SHA、采集时间、规则下限、模型执行/跳过状态和复核原因。server/恢复改动至少 HIGH；若涉及安全说明等规则，可达到 CRITICAL 并跳过 Jev。
5. 再次普通刷新：评论应仍只有一条，快照不变时复用判断。head/base、标题/正文、策略、问题或模型配置变化会形成新快照，不能只凭 head 相同认定不会调用。
6. 后续实际修正推送后，CI 开始/完成事件应更新到新 SHA；过期结果不得覆盖较新报告。按现有 TEX-61 验收完成业务 CI、审查意见闭环与人工合并。

没有 TEX-61 PR 时不猜测分支或 PR 编号，也不为试用改动业务逻辑。初次接入 PR 尚未在默认分支时，Observer 不会自动评估自身；这属于安装阶段边界。

## 6. 去重、状态恢复与停用

所有入口共用 PR 并发分组，`cancel-in-progress=false`。push CI 被跳过并使用独立分组，不挤占 PR 的 pending 任务。GitHub 可替换尚未开始的同组任务，不能据 run 数量估计模型调用数。

模型请求前必须成功持久写 reservation 到唯一机器人评论 ledger。完成响应跨 run 复用；RESERVED 崩溃或请求歧义进入 AMBIGUOUS，不自动重试模型。评论状态被删除、损坏或容量达到上限时停止新请求；不得靠删除评论“重新初始化”。隐藏 ledger 的容量有限，未支持多份 Observer 同时写相同 comment_key。

先检查失败代码：源码 checkout 失败检查只读 token 的仓库、Contents 权限和有效期；模型失败检查 TypeSafe key；无关联/旧 CI run 使用 `main` 手动刷新当前 PR。只有明确接受可能重复请求后，维护者才可填写当前 SHA、`rerun_reason` 并根据情况启用 `rebuild_state`。自由理由在公共 ledger 中用固定标记记录，保留 actor 与绑定快照。

停用可禁用此 Observer workflow，或通过配置 PR 关闭外发/模型。保留现有评论状态以避免恢复时丢失去重证据；不调整既有 CI 与审查配置。

## 7. 验证与文档同步

配置交付验证：严格 JSON/配置/Choice 问题校验、虚构路径/rename/混合变更/嵌套敏感文件回放、actionlint、Markdown 本地链接与秘密格式检查、`git diff --check`，以及接入 PR 的适用 GitHub CI。工具核心的 44 项验收和 Jev/评论行为已在独立项目及私有沙箱验证；不替代本仓库安装后的真实试用。

2026-10-03 本地接入检查：12 个路径下限及固定 NO 不降级验证通过，rename、混合迁移、根/嵌套敏感路径脱敏通过；11 个交付文件的严格 JSON/秘密格式检查通过，134 个本地文档链接及所涉及锚点通过。`actionlint v1.7.12` 检查全部当前 Workflow 通过（本机未运行 ShellCheck/pyflakes，新增 Workflow 没有内联 Shell/Python）；独立工具 `npm run verify` 的 44 项测试、类型和文档检查通过。没有业务源码/依赖变化，本地不重复安装或执行应用全量套件，接入 PR 仍由既有 CI 验证。PR 审阅、合入和 TEX-61 真实试用属于后续阶段，不能用上述本地结果代替。

本任务更新 `.ai-router/README.md`、Workflow README、工程/安全/项目索引和测试策略入口。扑克/协议/数据/前端/运行时业务规格已检查，无需更新，因为没有改变这些接口或业务行为；运维说明已检查，无需另建游戏运维文档，观察器恢复和停用在本文维护。TEX-61 原任务和产品路线图不改变。

配置与检查通过不等于已合入 `main`，也不证明 Jev 的 PR 分类准确率。真实试用证据需在 TEX-61 PR 就绪后追加到任务验收记录。

TEX-64 合入后运行：用户修正源码只读 Token 权限，再通过受信恢复入口初始化历史失败 run 未建立的状态。PR #71 的运行 37121912736 与普通刷新 37121949173 成功，仍更新唯一机器人评论 5969011141；报告为 CRITICAL / NEEDS_VERIFICATION、材料部分脱敏/截断、模型按规则跳过。该证据验证旧版安装与状态刷新，不证明当前仓库模型 Secret 已实际调用成功。

TEX-65 本地升级验收：工具 `npm run verify` 通过 51 项测试（含 7 项可读报告验证）、类型、文档链接及秘密格式检查；旧/新模板均能在新快照到来时标记过期，保留同一评论和隐藏 ledger。只读读取 PR #71 HEAD 8076f6bbae402e521cd21ab3dd8da7cc72c7c6c9 的路径规则生成中文预览，没有模型请求或 GitHub 评论写入。版本更新后仍需按 main 规则合入，再普通刷新获得正式报告；具体升级 PR/CI 证据记录在 TEX-65。目录 README 和本接入说明已同步；风险配置、业务权威规格、安全权限要求与应用测试策略已检查，无需修改，因为本次只调整展示及版本引用。
