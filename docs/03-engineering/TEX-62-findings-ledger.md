# TEX-62 / PR #80 Findings Ledger

核验日期：2026-10-19。基线 `63f4cbdd4323c85d1376bc542d214970a7698137`；用户指定 [失败 job](https://github.com/fujiabao89/Texas-Holdem/actions/runs/39199775112/job/117890144672)，核对完整 Actions 日志、固定 SHA 的脱敏产物及当前协议/发送实现后作出处置。

| ID | 发现与精确失败场景 | 当前实现与既有覆盖核验 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | 慢接收用例停读后无生产背压记录，35 秒轮询超时。认证预检成功，发送 47,771 探针含 11,943 个快照请求，服务端 SNAPSHOT_REQUESTED 为零。 | 压力分支漏发协议必填 lastSequence；validateClientCommand 在进入 REQUEST_SNAPSHOT 分支前拒绝，回复 INVALID_MESSAGE，未生成预期真实 Snapshot。原有代理、观察器与协议单测没有验证这段浏览器发送代码。将原发送逻辑提取后，以真实 ClientCommandSchema 检验，原码在 payload.lastSequence 明确失败；原生缓冲限制回归仍通过。 | P1 | 确认阻塞门禁：补齐已观察 sequence；同一发送函数由 E2E 与 Schema 回归共用，并以共享 ClientCommand 类型约束。保留 65,536 探针、256KiB 缓冲、生产背压及恢复/隔离断言和零重试。 |
| F-02 | 日志尾部重复 database tex_test does not exist。 | service 健康检查 pg_isready 省略数据库而使用用户名作为默认库；实际测试使用 tex_e2e，迁移、全部 20 项和 teardown 均已运行，另外 19 项通过。不是本次断言失败原因。 | P3 | 跳过：健康检查输出噪声，当前任务不捎带修改所有既有 Workflow。 |
| F-03 | 场景 teardown 打印 launcher 的 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL。 | timeline teardown 按 schema/PID 终止自有服务端并删除 schema；split/background 通过时也打印同样信息，失败断言发生在此前慢接收用例。 | P3 | 跳过：不属于运行中服务端崩溃，不以屏蔽 teardown 输出替代修复。 |
| F-04 | 修复合法压力请求后，恢复突发 Snapshot 导致 pageerror React 185。 | 本地真实链路仅 768 探针即接受 192 个快照并触发一次背压，随后 UI 报更新深度超限。独立 256 个同序列 Snapshot 浏览器回归在旧 production 代码上确定产生四次 React 185。倒计时和行动窗口 hooks 对每个新 clock 对象立即在 effect 中写入派生状态，造成同步更新链；既有时钟/恢复测试没有连续快照突发。 | P1 | 确认阻塞真实恢复：只调整两个计时 hooks，渲染直接读取当前权威 clock，保留原有截止、250ms 倒计时刷新及可见性更新；移除每个 Snapshot 后的即时派生状态写入。不批量丢弃 Snapshot，不改 deadline、校时或提交安全余量。为完成有效压力场景，这一最小产品修复随本 PR 交付。 |

验证和固定提交的集成结果见 [实施卡](../00-project/TEX-62-regression-gate.md)。本任务来自 Actions 失败，无对应原始 inline 审查线程；不向无关审查评论回复“已修正”。

## PR #80 三方审查复核（2026-10-19）

核验基线：`b533bf9dfa26fee4537216d5731ed54a1dd808d1`。从 PR 原始 review threads、review submissions 和 Conversation 收集 Codex 3 条、CodeRabbit 1 条、Greptile 3 条；摘要中重复出现的相同意见不另算发现。以下逐条区分真实性、严重性与是否阻塞本 PR，不把审查工具的等级直接当成裁决。

本轮只修复 F-05/F-08：两者共同影响 RC 入口能否启动并持续验证指定候选；F-08 为 P2，但与 F-05 同属此次入口可靠性修复，不能在扩大触发路径后仍让无关标签取消已启动的验证。F-06/F-07/F-09～F-11 是已确认的异常路径或覆盖缺口，未建立当前产品主流程故障，按非阻塞 P2 留档，本轮不扩展产品或测试实现。不能把它们写成“已有完整覆盖”或“已修正”。

| ID / 来源 | 有效性与精确失败场景 | 当前代码与既有覆盖核验 | 等级 | 处置与依据 |
| --- | --- | --- | --- | --- |
| F-05 / [Codex](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311283889) | 有效。PR 仅改 apps/web、packages/protocol 或 apps/game-server 时，即使添加 timeline-rc，pull_request.paths 也不匹配；后续 synchronize 继续漏跑。 | timeline.yml 只有三个测试/工作流路径；手动 dispatch 仍可运行，但不能补偿标签入口静默缺失。既有入口 meta 测试只检查 Playwright/脚本，不检查 Workflow 事件。修改前应用、协议、服务端三个样本路径均被拒绝。 | P1 | 确认阻塞 RC 入口：删除 paths，仍由 job 的 timeline-rc 标签准入，不把普通 PR 变为完整 RC。手动完整 SHA 入口保持原行为。 |
| F-06 / [Codex](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311283898) | 有效，但“污染下一轮”需收窄。timeline teardown 被调用时，如进程元数据缺失、JSON 损坏或 schema 不匹配，会在共享 teardown 前抛错，遗留 schema/身份。 | 对当前 teardown 注入三种元数据失败，均拒绝且共享清理未调用；无真实进程/数据库被操作。run-identity.test.ts 只覆盖身份续用/错端口拒绝；同端口重跑沿用身份，launcher 会 DROP/CREATE 同一隔离 schema，不会直接使用遗留牌局。元数据在 spawn 后立即写入；启动更早失败是否进入 Playwright global teardown 取决于启动阶段，本探针不宣称覆盖。 | P2 | 非阻塞，暂不修改：失败运行已报错；残留隔离资源及换端口受阻是真实清理缺口，没有证明生产数据污染或成功门禁被误放行。后续应在保留 PID/schema 所有权保护的前提下保证共享清理；不能直接终止未经验证的 PID。 |
| F-07 / [Codex](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311283908) | 有效的覆盖缺口。同一 handId/potIndex 的平分 POT_AWARDED 出现两次，各 payload 均自洽时，split 用例的金额守恒与命中平分检查仍通过。 | 执行当前 split 测试回调，提供两条相同派奖，分支断言接受（仅为隔离分支而 stub create/drive/最终 fixture assert）。fixture 的 authoritativeViolations 检查 HAND_STARTED 唯一，DOM 检查结算生命周期，不检查同一摘要内重复 pot。引擎 hand 测试已有事件 sequence 连续性与筹码/规则校验，但不能冒充本 E2E 的每 Pot 唯一性覆盖。 | P2 | 非阻塞，暂不修改：未复现当前产品重复结算；这是新增门禁的负例覆盖不足，非已证明的筹码错误。保留与 06 §9.3 A3 的覆盖差距，后续增加 hand/pot 身份唯一性负例，不能只比较 payload 金额。 |
| F-08 / [CodeRabbit](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311291025) | 有效。已带 timeline-rc 的 PR 添加任意其他标签，旧 job 条件仍为真；workflow 级同组并发取消正在执行的 RC 并重跑同 SHA。 | 当前条件只检查标签集合，不检查本次新增标签；并发在 job 判断之前作用于 workflow。GitHub 官方表达式解释器复核：带 RC 的 PR 添加 bug 标签仍选中 job。既有测试未覆盖该调度路径。 | P2 | 作为 RC 入口可靠性阻塞一并最小修复：labeled 只接收 timeline-rc 本身；concurrency 下移到 job，跳过的作业不取消候选。opened/reopened/synchronize 和 workflow_dispatch 保持原准入。 |
| F-09 / [Greptile](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311370374) | 有效。clock receipt 在截止前、effect 执行在截止后时，remaining <= 0 不设 timeout；渲染仍取旧 state/receipt，按钮可能继续 enabled，点击无响应直到下一 clock/visibility 更新。 | 执行从当前源码提取的 hook：receipt=99、deadline=100、effect=101，未设 timer，随后渲染仍 true；同一源码 hasSubmissionTime 的实时检查为 false。此为 hook 级调度探针，未声称真实 React 渲染复现。submit/retry/Time Bank handler 均实时复核；既有 clock/截止/256 Snapshot 回归未专门覆盖该 effect 跨截止竞争。 | P2 | 非阻塞，暂不修改：确认反馈缺陷，但 handler 不会发送过期行动，服务端权威截止仍生效。避免为非阻塞反馈再次改动刚修复 Snapshot 更新链的产品 hooks。 |
| F-10 / [Greptile](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311370398) | 有效的覆盖缺口。非房主收到终局 Snapshot，但缺全部 POT_AWARDED 及 DOM 分配时，completedHandIds 可计完成，expectedAwards=[] 的 every 为空真，fixture.assert 仍通过。 | 执行当前六人 fixture.assert 原方法，独立提供终局与 DOM 观测：仅玩家 1 缺派奖事件/展示，断言接受。hand-boundary.test.ts 明确允许终局 Snapshot 计完成，场景金额/Reveal 主要核对 players[0]；没有独立预期批次。已有序列/重同步和生产事件发送保护，但不是此全员断言的替代。 | P2 | 非阻塞，暂不修改：未证明当前服务端实际漏发；这是全员证据对照盲区。后续需独立公开预期批次并明确后台/恢复例外，不能盲目要求恢复客户端重放 Snapshot 中不包含的历史分配，也不能称当前门禁已全面覆盖非房主丢结果。 |
| F-11 / [Greptile](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311370410) | 有效的覆盖缺口。Reveal-only 摘要先显示 1,200ms，完整 award 最后只显示 50ms，再消失，timelineViolations 仍从首次摘要计时而接受。 | 对当前 validator 直接输入此序列，返回 []；分配存在性检查也只要求某次 sample 出现。presentation-lifecycle.test.ts 已验证完整分池实际绘制后 999ms 不切手、1,000ms 切手及恢复目标独立阅读窗口，但真实链路 validator 未独立保证最后一项 award 的完整阅读时间。 | P2 | 非阻塞，暂不修改：已证明门禁负例不足，未证明当前产品违反 05 §9.7 的完整摘要停留。后续应由完整预期 awards 启动阅读窗口并增加晚到最后一池的负例；本轮不扩大证据模型。 |

### 本轮验证与交付边界

- 改动前逐条执行源码探针；Workflow 事件/路径/并发矩阵为 7/12，失败正好对应两项入口问题。其余五条确认依据与探针限制已写在各行，不据此宣称产品故障或 E2E 已覆盖。
- 修改后验证（Linux、Node 24.19.0、pnpm 11.25.0）：GitHub 官方 @actions/expressions 解释当前 job.if，手动、RC 标签、无关标签、opened/reopened/synchronize 与普通 PR 共 8 例，加三个生产路径与 job 并发位置检查，12/12 通过；actionlint 1.7.12 检查 timeline.yml 通过；git diff --check 和两份改动 Markdown 的 8 个本地链接目标通过。临时探针不加入仓库或扩大依赖。
- pnpm lint、pnpm typecheck 通过；仅既有 gateway-protocol.test.ts unused room 警告。首次 pnpm test:unit 在全新检出、共享包 dist 未构建时为 74 文件/675 项通过、22 文件无法解析 workspace 包；typecheck 的依赖构建完成后重新执行，96 文件/1009 项全部通过。前次失败是本地构建前置条件缺失，未修改源码或降低断言。
- 本轮只改变 Workflow 调度及文档，未在本地重跑需要 PostgreSQL/浏览器/Xvfb 的完整 PR 9 项/RC 20 项；新提交的远端门禁状态以 GitHub Checks 为准，历史 b533bf9 的通过不能替代新候选结果。
- 文档同步：更新工作流 README 与本 Ledger；测试/前端 README、01～06 权威规格、实施卡、安全和运维要求已检查，无需改变既有接口、测试矩阵或运行命令。只调整 RC 事件准入和并发位置，无业务、协议、计时或测试断言修改。
- 提交并推送后，在七条原始线程分别回复实际处置；未修复项说明非阻塞依据，不使用“已修正”。不自行触发 Greptile/DeepSeek Harness，不合并 PR。

## 最新候选复核（8be79816）

重新读取 PR 全部 8 条原始审查线程、13 份 review 和 10 条 Conversation 评论（分页均已取完），并复核 Greptile 在 PR 描述中的摘要。F-05/F-08 在当前代码仍已修复，原七条线程已有对应处置回复。再次执行当前源码的五项隔离探针，F-06/F-07/F-09～F-11 的缺口与上表一致，继续保留为非阻塞 P2；探针的 stub/观测限制也保持不变，不称其已修复。

| ID / 来源 | 有效性、失败场景及既有代码/验证 | 等级 | 处置 |
| --- | --- | --- | --- |
| F-12 / [Codex](https://github.com/fujiabao89/Texas-Holdem/pull/80#discussion_r4311589393) | 不成立。声称 pull_request Workflow 必须先存在于默认分支，否则本 PR 的标签入口不会运行。当前 main 确实没有 timeline.yml，但 [8be79816 的 pull_request RC](https://github.com/fujiabao89/Texas-Holdem/actions/runs/39218470193) 已实际执行完整 20 项，前一候选 b533bf9 的同入口也已运行并通过。[GitHub 官方 pull_request 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) 使用 PR merge ref，没有该默认分支前置条件；不能套用其他事件的限制。 | P3（原报 P1，未成立） | 跳过：无所称调度失败场景，不为此新增 dispatcher、提升权限或先合并 main。在原始线程说明官方规则和实际运行证据，不回复“已修正”。 |
| F-13 / CodeRabbit Conversation | Docstring coverage 35% 低于机器人 80% 建议。当前 .coderabbit.yaml 明确关闭 finishing_touches.docstrings；仓库 CI 没有该比例门禁，未指出接口误用或运行失败。 | P3 | 跳过：样式建议，不为补比例添加注释或改写本 PR。 |
| F-14 / 三方摘要及工具状态 | Greptile 描述摘要重复 F-09～F-11；CodeRabbit review 摘要重复 F-08；Codex receipt/Conversation 指向原线程。AI Router 的风险/PARTIAL 提示没有独立代码缺陷，Copilot/Qodo 配额与 CodeRabbit 限流消息也未产生代码发现。 | P3 | 去重或无可核验发现；不执行摘要内自动生成的审查触发链接，不把工具未运行当成已通过审查。 |
| F-15 / 当前 Actions 阻塞 | [8be79816 RC](https://github.com/fujiabao89/Texas-Holdem/actions/runs/39218470193/job/117947863328) 为 19/20，仅慢接收未形成生产背压。合法性断言通过，但 45,181 个混合探针中，服务端仅接受 338 个快照请求，全部完成写出，目标无 RESYNC_REQUIRED/SLOW_CONNECTION_CLOSED；代理及六名玩家错误均为零。三份小 TIME_SYNC 请求夹一份快照的压力密度未可靠填满该环境的发送缓冲。 | P1 | 最小调整测试注入：每个探针都请求真实接收者 Snapshot，将批次数由 256 降为 64，保持原 16,384 个快照请求总上限及 256KiB 原生发送缓冲上限。减少上行小探针竞争，不改生产阈值、时钟、恢复/隔离断言或零重试。旧 Windows 场景可通过，不能替代 Linux 新候选验证；338 后停止接受请求的更底层机制尚未证实，不据此改动产品网络实现。 |

验证：当前源码五项缺口探针和入口八种事件复核通过；压力命令 Schema、发送缓冲、真实 TCP FIFO/有界代理及证据校验共 12 项通过。pnpm test:unit 为 96 文件/1009 项通过，pnpm typecheck、pnpm lint 通过（仅既有 unused room 警告），actionlint 1.7.12、17 份 Markdown/299 个本地链接及 git diff --check 通过。本地 production build 的真实 PostgreSQL 六人慢接收 1/1 通过：256 个请求全部被服务端接受，目标产生一次重同步，六名玩家错误为零，独立审计 4 文件通过；报告标记 dirty=true，不冒充已提交候选。新固定候选 CI 结果在交付时报告；原 8be79816 的失败保持可追溯，不能以历史绿色或原 SHA 重跑代替修复证明。

文档同步：本 Ledger、实施卡及两个测试目录 README 同步压力输入与审查处置。01～06 权威规格、前端/服务端 README、产品、安全及运维要求已检查，无需更新：本轮没有业务、协议、数据库、生产时钟或部署行为变更。
