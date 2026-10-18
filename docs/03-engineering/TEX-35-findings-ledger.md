# TEX-35 / PR #79 Findings Ledger

核验日期：2026-10-16。当前审查基线为 `95d5134298cfbbb67f97e00aa9214b2c59e09181`，目标 [PR #79](https://github.com/fujiabao89/Texas-Holdem/pull/79)。已读取全部两个原始 inline 线程、三个 review bodies、八条汇总/状态评论及 PR body；每条先对照当前实现、05 的展示契约和既有测试，再判断是否修改。未启动 Greptile、DeepSeek Harness 或其他新审查器。

## 逐条核验与处置

| ID | 来源 | 有效性、精确失败场景与既有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Codex 4292096824](https://github.com/fujiabao89/Texas-Holdem/pull/79#discussion_r4292096824) | 有效。41 个普通事件触发无结果的 Hard Forward 并请求 Snapshot；响应到达前，同手主池平分及边池派奖被连续接受，但只进入 `forwardOutcomeEvents`。恢复的 `commitAllFinalFrames(true)` 从空 `state.outcomeEvents` 初始化，随后清空恢复结果，两个 Pot 均消失。旧测试覆盖请求前已有结果及 Hard Forward 中换手，没有覆盖请求与响应之间新收到派奖。新增用例在原代码上实际得到空数组而失败。 | P1（原评论 P2） | 确认阻塞：已接收分池结果无法由 Snapshot 重建，违反本 PR 的结果一致性验收。恢复清装饰前收集匹配目标快照的已接收结果，保留两个 Pot；沿用绘制确认和完整 1,000ms 窗口，不改变服务端裁决。 |
| F-02 | [Greptile 4292198437](https://github.com/fujiabao89/Texas-Holdem/pull/79#discussion_r4292198437) | 有效，独立于 F-01。前台已接收 hand-1 的派奖、hand-2 的开手和 222 筹码派奖；hand-1 仍在播放时到达 hand-2 恢复 Snapshot。批量终帧在第一手结果处停止，剩余 hand-2 事件被 `queue.splice(0)` 清除，跨手分支又把 forward 结果设为空。旧回归只给后一手普通动作，未给后一手自身结果；后台最新手缓存也不覆盖前台队列。新用例在旧代码上一秒后切到 hand-2，但 222 结果为空，确定失败。 | P1 | 确认阻塞：清队列前保留恢复目标手的已接收结果，第一手阅读完成后静态呈现第二手结果，再等待它自己的绘制确认及一秒窗口。陈旧第一手绘制通知无效；第三手操作在第二手阅读期间仍关闭，不重播旧派奖音效。 |
| F-03 | [CodeRabbit 6124560021](https://github.com/fujiabao89/Texas-Holdem/pull/79#issuecomment-6124560021) 的 Docstring Coverage（25% / 80%） | 风格建议，没有具体行为失败。`.coderabbit.yaml` 的 `finishing_touches.docstrings.enabled=false`，仓库 required CI 和本任务验收未设该覆盖率门槛。职责与生命周期契约已有 README 和权威规格。 | P3 | 跳过：不补无关注释、不改审查配置或泛化重构。 |
| F-04 | PR body 的 Greptile Findings / merge-risk 汇总 | 与 F-02 为同一根因、同一原始线程和同一双手复现；没有第三个独立场景。已读取其“后一手 222 消失、stack 更新”的描述，并以当前代码的受控回归独立确认，不依赖外部视频或其合并建议代替核验。 | P1 | 重复，合并到 F-02 的修复和原始线程回复，不重复实现。 |
| F-05 | [Codex Review Summary 6210599216](https://github.com/fujiabao89/Texas-Holdem/pull/79#issuecomment-6210599216) 及 [review 5544530199](https://github.com/fujiabao89/Texas-Holdem/pull/79#pullrequestreview-5544530199) | 汇总指向 F-01，没有另一条代码发现。P2 是发布者原等级；本轮按分池摘要丢失的具体影响重新定为 P1。 | P1 | 重复，合并到 F-01。 |
| F-06 | [AI PR Router 6186511776](https://github.com/fujiabao89/Texas-Holdem/pull/79#issuecomment-6186511776) 的 HIGH / PARTIAL / NEEDS_VERIFICATION | 观察元数据和审查深度建议，没有提供可独立复现的代码缺陷。风险下限来自权威规格路径，补丁裁剪和兼容性低置信度也不能当作实际漏洞。 | P3（信息项） | 跳过代码变更；本轮已人工核查恢复、状态与测试，不触发建议的新审查器。 |

Copilot 额度不足、Qodo 试用结束、CodeRabbit 完成回执/无 actionable finding、Linear/Vercel 状态及用户的审查请求均不构成代码发现。Greptile review body 为空，实际发现已完整纳入 F-02。没有确认的 P0 问题；未将 UI 结果丢失误写为服务端筹码裁决错误或权限漏洞。

## 最小变更与验证

- 运行时代码仅修改 `AnimationQueue` 的恢复结果提取和阅读计时交接；匹配 tournamentId、handId、viewer.playerId，且来源 sequence 不大于恢复 Snapshot。仅消费已接受的公开 Reveal/Pot 事件，不读筹码差、不制造赢家、不改变 canonical、wire、deadline 或后台缓存策略。
- F-01/F-02 的两个新增回归在修改前均失败；修改后动画与 ProjectionStore 四个文件共 57 项通过，包括四种赛事/接收者/序列/手牌不匹配的排除回归。延迟绘制、旧通知、第三手推进、静音恢复和 Timer 清理均被断言。
- 定向命令：`pnpm exec vitest run --project unit apps/web/src/animations apps/web/src/state/projection-store.test.ts --maxWorkers 1`。
- 浏览器命令：`pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts --workers=1 --grep 'TEX-35|减少动态效果仍保留|后台'`，4/4、零重试。使用既有 `animation-audio` 协议投影夹具、真实 React/DOM 和 Playwright Clock；1366/390px 覆盖 111→222→第三手的实际摘要及操作准入，既有 Reduced Motion 和后台恢复也通过。该受控用例不冒充真实游戏服务器、PostgreSQL 或实机/公网验收。
- 初版浏览器夹具只发送同序列 Snapshot，现有连续快照分支正确保留动画，两个新增用例未进入恢复而失败。夹具现发送合法 RESYNC_REQUIRED，经真实 Transport 发出 REQUEST_SNAPSHOT 后回复 Snapshot，修正后上述 4 项全通过；历史失败单独保留，不以重试同一夹具取得绿色结果。类型检查另检出新测试的 Snapshot reason 误用命令枚举 MANUAL，已改为协议定义的 RESYNC 并通过全仓类型检查。
- `pnpm typecheck`、`pnpm lint`、11 份 Markdown / 186 个本地链接及 `git diff --check` 通过；lint 只有既有的 gateway-protocol.test.ts unused room 警告。本地 `pnpm test:unit` 默认并发为 977/979，两个未改动的服务端启动用例触发原 5 秒超时；保留该失败。`pnpm exec vitest run --project unit --maxWorkers 1` 诊断为 90 文件 / 979 项通过，未改超时/重试配置；串行诊断不替代新提交的默认 CI 门禁。未以之前 TEX-62 的其他 SHA 的 RC 20/20 代替本轮修改验证；PR #80 集成新的 #79 提交后，须重跑受影响的固定候选门禁。

## 文档与原始线程闭环

同步动画 README、浏览器测试 README、05 的恢复摘要契约、06 的测试覆盖、TEX-35 验收记录、工程索引和本 Ledger。任务卡/路线图、Web/牌桌/state README、02 协议、01/03/04、安全和运维说明已检查，无需更新：本轮仅落实既有展示语义，不增加公开接口、传输字段、规则、数据结构、权限、日志、运行配置或部署流程。

F-01/F-02 必须在适用验证通过、提交并推送至 #79 源分支后，各自在上表对应的原始 inline 线程回复 `已修正`；回执以 GitHub 原线程为准。重复和非阻塞汇总的依据保留在本 Ledger，不重复回复为新缺陷，也不自动启动审查器。

## 增量核验：第三手在第一手阅读结束前到达

2026-10-18，审查基线 `5ae3bb0b6786a82d7a97d54da16d2c4ed2eb1134`。用户指定处理新增 Codex P1；未触发新的审查器。

| ID | 来源 | 有效性、精确失败场景与既有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-07 | [Codex 4294771785](https://github.com/fujiabao89/Texas-Holdem/pull/79#discussion_r4294771785) | 有效。hand-2 的恢复 Snapshot 已保留 222 分配，UI 正等待 hand-1 的绘制/阅读；此时 hand-3 HAND_STARTED 到达，HARD_FORWARD 分支清空共享 `forwardOutcomeEvents` 并推进 `tailTarget`。第一手窗口结束后直接显示第三手，第二手未曾绘制。F-02 的旧用例在第二手已显示后才发送第三手，不能覆盖这个顺序；后台缓存也不是前台待展示结果。新增“提前第三手”“提前第三手并收到新 Snapshot”两条回归在修改前均失败：实际 hand-3 / 空结果，期望 hand-2 / 222。 | P1 | 确认阻塞，独立修复。新增一份有界待展示恢复摘要，与最新 canonical 目标和最新公开结果分开；第一手结束后先呈现恢复目标，等待它自己的绘制确认和完整一秒，再对齐最新手。后续同手分池更新该摘要，同赛事/接收者且序列有效的新 Snapshot 不覆盖尚未展示的旧恢复目标；取消、后台和身份不匹配清理它。 |

运行时代码只触及 AnimationQueue：至多多保留一份恢复目标的 Snapshot/公开结果，不建立随第三手事件增长的重放队列，不重算赢家，不延长服务端 deadline。普通阶段 Snapshot、原 Hard Forward、后台最新手缓存和静音恢复契约保持原样。

直接验证：`pnpm exec vitest run --project unit apps/web/src/animations apps/web/src/state/projection-store.test.ts --maxWorkers 1`，4 文件 / 63 项通过。包含上述两个旧码失败回归、延迟绘制与陈旧通知、取消/后台/接收者重置三条清理回归，以及新 Snapshot 抢在已到期但尚未执行的阅读 Timer 之前到达的回归，均检查无遗留 Timer。结果内容相同也不跨 handId 复用旧绘制确认。相同浏览器命令现为 6/6、零重试：1366/390px 各跑第三手提前/随后到达两种顺序，均依次看到 111→222，再开放第三手操作，另含既有 Reduced Motion/后台两项。`pnpm typecheck`、`pnpm lint` 通过（仅原有 unused room 警告）；完整 CI 以本轮新提交回执为准，不引用旧 SHA 代替。

同步动画/浏览器 README、05/06 展示与测试说明及 TEX-35 验收记录。任务卡/路线图、02 协议、01/03/04、Web/牌桌/state 目录、安全和运维说明已检查，无需更新：仅修补已批准的展示生命周期，不改变模块边界、公开接口、传输字段、权限、数据库或部署配置。F-07 须在验证、提交并推送后于上述原始线程回复 `已修正`；已有 F-01/F-02 的回复不代替本线程闭环。
