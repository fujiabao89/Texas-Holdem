# TEX-61 / PR #71 Findings Ledger

核验日期：2026-10-03。审查及复现基线：`d9d28d38c2e9503488618864dc6a6bc211881780`。范围为 [PR #71](https://github.com/fujiabao89/Texas-Holdem/pull/71) 已发布的 Codex、Greptile、CodeRabbit 审查；读取了全部 inline comments、review bodies 和汇总评论，对照当前代码、规格与既有测试后再修改。未启动新的审查器、Greptile 或 DeepSeek Harness。

四条独立问题均确认属于 P1 阻塞项，分别修复；三个重复表述合并到同一修复，两个非阻塞建议跳过。没有 P0 问题，没有扩大为规则、协议版本、持久化或时钟架构重构。

## 逐条核验与处置

| ID | 来源 | 有效性、精确失败场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Codex 4173266511](https://github.com/fujiabao89/Texas-Holdem/pull/71#discussion_r4173266511) | 有效。已认证牌局连接具有快照屏障，未发送控制回复累计超过 256 KiB。恢复快照在第 5 秒完成且 Socket 缓冲为零，但应用控制队列仍超软限；旧实现清空原期限，下一轮恢复再次插队并重置期限。Fake Clock 验证原第 30 秒仍未关闭。既有超时用例只停滞首个回调，没有覆盖恢复完成后控制队列仍超限。 | P1 | 修复：清空期限必须同时检查 `queueBytes + bufferedAmount` 低于软限；否则保留最初起点，到期仍关闭 1013。新增控制积压回归，不调整阈值或重构调度。 |
| F-02 | [Greptile 4173283075](https://github.com/fujiabao89/Texas-Holdem/pull/71#discussion_r4173283075) | 有效。恢复快照 sequence=100 已写出，完成回调尚未返回，此时同 sequence 的当前行动者/截止线发生变化。旧 `recovering` 分支直接丢弃后来的 Snapshot，已写出的帧也无法刷新。既有“RESYNC_REQUIRED 在途”测试只覆盖恢复快照写出之前的重新投影，不覆盖写出之后。新增测试复现只送旧快照，随后直接送 Event 101。 | P1 | 修复：区分恢复快照已写出/未写出；写出后将后续权威快照合并保留一份，在旧帧之后交付，并保持事件屏障。验证两次同序列更新仅发送最新一份，覆盖事件 100 被过滤，101 正常继续。 |
| F-03 | [Greptile 4173283077](https://github.com/fujiabao89/Texas-Holdem/pull/71#discussion_r4173283077) | 有效。小型 TIME_SYNC_RESULT 的 send callback 停滞、Socket bufferedAmount=0，随后成员被踢。网关同步撤销 epoch/订阅/心跳，却只等待 outbox idle；该帧未触发软限，既有心跳与背压恢复期限均不能关闭它。新增 Fake Clock 用例确认撤销已生效，但第 30 秒 Close 4003 仍未出现。旧踢人测试与闭房竞态只覆盖正常发送完成。 | P1 | 修复：成员撤销时启动独立的 30 秒最终回执排空期限，到期 dispose outbox 并使用既有 4003；正常排空立即关闭并清期限，close 事件也清理。另验证 close 握手未完成时无 Timer 遗留、迟到发送回调不复活或重复关闭。 |
| F-04 | [CodeRabbit 4173285100](https://github.com/fujiabao89/Texas-Holdem/pull/71#discussion_r4173285100) | 有效。生产 Gateway 的 `now` 默认 Date.now；恢复快照写出期间墙钟从 10000 回拨到 9000，完成回调传入 delayMs=-1000。Metrics.observe 拒绝负观测并抛 MetricsError，原指标调用在日志 try/catch 之外，异常逃出异步完成回调并跳过 pump。默认未捕获异常可扩大到进程可用性；本地实际复现到回调抛错。既有日志出口失败测试未覆盖指标失败；Executor 的诊断隔离不覆盖 Gateway。 | P1 | 修复：诊断指标更新单独 try/catch，保留日志与指标的独立失败隔离。负样本由现有指标校验拒绝，不伪装零延迟；新增真实指标负观测、counter 失败和 outbox 异步回拨三条回归，确认后续控制帧排空。 |
| F-05 | [CodeRabbit review 5400916073](https://github.com/fujiabao89/Texas-Holdem/pull/71#pullrequestreview-5400916073) 的指标保护建议 | 有效但重复 F-04，同一诊断函数及失败场景，没有独立的新缺陷。已核对其所有 inc/observe 均在新增保护范围。 | P1 | 合并到 F-04；不重复实现或额外调用建议的本地审查命令。 |
| F-06 | [CodeRabbit 汇总 5966035448](https://github.com/fujiabao89/Texas-Holdem/pull/71#issuecomment-5966035448) 的 Merge Risk | 有效但重复 F-04：系统校时造成负恢复延迟并逃出指标回调。其所述合并前保护要求已由 F-04 满足。 | P1 | 合并到 F-04；无需另一套回调/指标抽象。 |
| F-07 | 同一 CodeRabbit 汇总的 Security Architecture / Retained concerns / Attack Paths | 可用性失败链有效，仍是 F-04 的重复表述。报告也明确服务器时钟校正独立于客户端、没有证明客户端单独利用、提权或私密数据泄露；不将其升级为已证实的权限漏洞。现有 epoch/接收者投影仍守住权限边界。 | P1 | 合并到 F-04 的诊断隔离与异步回归；不改授权或私密投影。 |
| F-08 | 同一 CodeRabbit 汇总的 Hardening Proposals | 非阻塞建议：整体将 Gateway 期限测量改为独立单调时钟并泛化隔离所有回调。负观测的确切失败已按 F-04 修复；报告未为更广泛架构改造提供另一条需要阻塞本 PR 的场景。Tournament 既有单调时钟不代表 Gateway 已切换。 | P3 | 跳过泛化重构；保留当前时间接口和字段语义，仅修已确认问题。 |
| F-09 | 同一 CodeRabbit 汇总的 Docstring Coverage（29.63% / 建议 80%） | 风格建议，未产生行为失败。`.coderabbit.yaml` 的 `finishing_touches.docstrings.enabled=false`，仓库验收与 required CI 未规定该阈值；既有职责/接口文档已维护。 | P3 | 跳过：不为机器人覆盖率补泛化 docstring，不改变审查配置。 |

Greptile review body 为空，其两个 inline finding 均已纳入 F-02/F-03。Codex review 总结只指向 F-01。Copilot 在较早提交报告额度不足，没有可核验 finding；CodeRabbit 的完成回执、变更摘要和四项通过检查没有新增缺陷。AI PR Router 的规则风险/上下文裁剪标记属于观察元数据，不能当作代码缺陷或替代这次逐条核验。

## 最小变更与验证

- 运行时代码仅涉及 `connection-outbox.ts` 的期限与后续快照处理、`lobby-gateway.ts` 的撤销排空期限、`game-diagnostics.ts` 的指标异常隔离。阈值、Close 码、身份撤销时点、规则和 Schema 不变。
- 七条新增行为回归。修改前六条独立复现均失败，涵盖四个根因；正常提前排空/取消期限作为修复后的补充保护。相邻旧测试不能代替这些失败场景。
- 定向 Gateway/outbox/observability、Room 生命周期竞态、Room 恢复、TournamentExecutor 与 performance：16 个文件、227 项通过。`pnpm test:ws`：2 个文件、11 项通过，包含真实 Socket 链路。
- 修改 TS 文件 ESLint、全仓 `pnpm typecheck`、game-server build、相关新增片段格式、Markdown 本地链接和 `git diff --check` 作为交付验证；CI 以本轮提交的实际运行结果为准。
- 本轮没有重复运行浏览器或真实 PostgreSQL 长时场景；此前 perf-smoke 已证实修复前后的完整 90 秒链路，见 [验收记录](./TEX-61-acceptance.md)。本轮 Fake Clock 与受控 send callback 针对真实时间无法稳定复现的精确竞态；不外推为正式容量或生产告警验收。

## 文档与评论闭环

同步 Gateway/observability README、02 的快照交付说明、04 的有界恢复/撤销与 CLOSED 交叉引用、06 的测试覆盖、运行手册、工程索引和本 Ledger。产品范围/路线图、01 规则、03 数据、05 前端、根 server README、Room/persistence/tests 客户端 README 与安全说明已检查，无需更新：接口、资产职责、规则、授权和字段白名单未改变；本次未增加运行配置或数据库迁移。

F-01 至 F-04 各自对应原始 inline 线程，交付必须在修改验证、提交并推送后逐一回复 `已修正`。F-05 至 F-09 为重复/非阻塞汇总内容，其依据记录于本表；不把重复意见再实现一次。回复与推送回执以 GitHub 原始线程及交付摘要为准，不自动启动新的审查。

## 增量核验：事件压力下的恢复期限

2026-10-03，基线 `8076f6bbae402e521cd21ab3dd8da7cc72c7c6c9`。按用户本轮限定，仅处理以下新增阻塞意见。

| ID | 来源 | 有效性、精确失败场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-10 | [Codex 4173507954](https://github.com/fujiabao89/Texas-Holdem/pull/71#discussion_r4173507954) | 有效。第 0 秒触发恢复，恢复 Snapshot 回调停滞期间，累计 64 个新事件，或一个新事件等待满 5 秒；总字节均低于 256 KiB。事件数场景第 1 秒、年龄场景第 5 秒完成 Snapshot 时，字节判断清空原期限，下一轮恢复重设起点，导致原第 30 秒仍不关闭。既有事件数/年龄用例只验证首次触发，F-01 只覆盖控制字节积压；本条是未覆盖的独立失败场景，不能作为重复意见跳过。新增两条回归在修复前均于原第 30 秒未关闭而失败；事件数场景保持年龄低于阈值以独立验证。 | P1 | 修复：删除 Snapshot 完成回调中仅按字节提前清空期限的一行，由紧接着的既有 `pump()` / `check()` 统一检查事件数、年龄和字节压力，再决定是否清除期限。两个场景均保留原起点，到期关闭，迟到回调不再发送且 Timer 归零。未改阈值或调度结构。 |

直接相关验证：`pnpm exec vitest run apps/game-server/src/realtime/gateway/connection-outbox.test.ts apps/game-server/src/realtime/gateway/lobby-gateway.test.ts`，2 个文件、36 项通过，其中 outbox 14 项包含两条新增回归及正常恢复排空的既有保护。另验证 game-server 类型、测试类型、改动 TS 的 ESLint/Prettier 与 `git diff --check`。

同步 Gateway README、04 §9.5 和 06 的恢复期限/测试说明。任务卡/路线图、协议、运维及安全说明已检查，无需更新：仅修复既有三类背压阈值的期限保持，接口、关闭码、配置、权限和部署流程均未改变。F-10 必须在验证、提交及推送后于上述原始线程回复 `已修正`，回执以 GitHub 线程为准。
