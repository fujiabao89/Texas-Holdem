# TEX-61 验收记录

PR #71 的 Codex、Greptile、CodeRabbit 逐条核验与最小修复见 [Findings Ledger](./TEX-61-findings-ledger.md)，其中包含控制积压期限、在途快照后的更新、撤销回执期限及诊断指标隔离的复现与验证。

任务：[TEX-61](https://linear.app/texas-holdem/issue/TEX-61)。用户直接委派 Codex 实现、提交、推送并创建 PR；从包含 TEX-59/60 的 origin/main 开始，分支 `fix/TEX-61-slow-client-backpressure-observability`。没有修改其他任务工作区的未提交文件。

## 范围与证据

- 每连接有界 outbox：独立事件数/年龄/字节软触发，硬字节限和恢复超时；所有出站控制回复也受限。阈值以 04 §9.5 为准。
- 背压时丢弃未发送旧牌局帧，只保留恢复意图；可发送时读取当前接收者权威投影，按 RESYNC_REQUIRED → GAME_SNAPSHOT 建立屏障，过滤已覆盖的延迟扇出。
- 1013 关闭立即撤销订阅/心跳/epoch，经既有权威断线队列处理，后续原身份重连；替换、成员结束、闭房/关停释放队列/检查 Timer。闭房等待最终 Lobby 回执传输完成。
- 权威开手/展示与街阶段/自动 Check-Fold/过期 Timer/晚到与幂等操作/连接与快照/背压日志。身份与时间可关联，字段白名单排除私密 Payload。
- 自动操作、过期回调、晚到/重复 Action/Time Bank、快照、背压恢复/关闭和等待/执行延迟指标；/health 的版本和部署 SHA 验证与 no-store。
- 无数据库迁移、协议主版本或规则改动，不改变公平性与行动截止线。

自动化证据：

| 入口 | 验证 |
| --- | --- |
| connection-outbox.test.ts | 64 条/5 秒/256 KiB 精确边界、总量 1 MiB、30 秒未恢复、控制回复上限、回调失败/null、延迟回调不复活、成员撤销与最终回执 |
| lobby-gateway.test.ts | 同桌慢/快接收者隔离、换手后最新 handId/sequence/玩家投影、旧批次过滤、1013/重连、指标与日志脱敏 |
| tournament-executor.test.ts | 每实际开手一条诊断、旧 Timer generation no-op、正常自动 Fold、晚到/重复操作、时延与阶段字段 |
| game-diagnostics.test.ts / app.test.ts | 字段白名单、意外私密字段剔除、格式受限构建身份、指标与无缓存 /health |
| room-lifecycle-races / room-recovery / 真实 WS | 闭房回执、替换与订阅清理、终局恢复、Node send callback 正常行为 |

## 验证结果

最终本地验证（2026-10-03）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 成功，未修改锁文件 |
| `pnpm exec vitest run` | 94 个文件通过、13 个数据库测试文件跳过；983 项通过、101 项跳过 |
| `pnpm lint` | 通过；既有 `tests/ws/gateway-protocol.test.ts:61` unused room 警告 1 项，未扩大任务范围修改 |
| `pnpm typecheck` | 全仓及根测试 TypeScript 检查通过 |
| `pnpm --filter @texas-holdem/game-server build` | 通过 |
| 新增 outbox/诊断文件 Prettier 与 `git diff --check` | 通过 |

完整测试包含新加入的“RESYNC_REQUIRED 在途时同 sequence 阶段变化仍获得最新 Snapshot”和“1013 关闭握手未结束前撤销 epoch”回归。CI 与人工评审以 PR 实际状态为准；未本地运行浏览器 E2E 或数据库集成，不把跳过计作通过。

## 文档同步检查

已更新涉及的 server/source/realtime/gateway/observability/tournaments/rooms/persistence README、02/04/06 权威规格、docs 索引、项目任务索引、安全说明与运维手册，明确实现与部署验收边界。01 引擎规则、03 数据模型、05 前端规格及产品总规划已检查，无需更新：规则、持久化、客户端行为和产品范围未变。既有真实 WS 测试目录已检查，无需更新：测试入口和资产职责未改变。没有引入空模块或重复 DTO。

## 未覆盖边界

没有实际数据库/外部日志采集/真实通知渠道验证；101 项数据库测试跳过不计作通过。本任务提供阈值、告警排查和日志保留契约，部署方需配置并核验采集及送达，不能宣称生产监控已验收。弱网浏览器动画/时序完整端到端门禁由 TEX-62 承担；send callback 不是客户端读取/播放 ACK。本地受控单连接背压加真实 WS 回归不外推为生产容量或长时 soak 结论。没有调用 DeepSeek Harness 或手动触发 Greptile。
## PR #70 合入后的同步

2026-10-03，PR #71 源分支合并 main 的 `30838fe1`（TEX-64 / PR #70）。唯一冲突位于安全 README，保留 TEX-61 日志白名单/投影约束与 TEX-64 观察器授权说明；其余索引和测试策略自动合并。观察器配置与 Workflow 保持 main 的版本。

本次合并无应用、共享包、测试或依赖变更，不重复应用全量测试。已检查：无未解决冲突或冲突标记，工作区与暂存差异空白检查通过，140 个本地 Markdown 文件链接通过，两份观察器 JSON 可解析。目录 README、权威规格、任务索引、测试与运维/安全说明已检查；除保留双方文档与本同步记录外，无需更新，因为运行时接口和行为未变。CI 以合并提交的实际运行结果为准。

## PR #71 perf-smoke 修正

2026-10-03，CI run `37100866689` 的唯一失败项为 perf-smoke。原压测序列检查器只读取 GAME_EVENT，未处理权威 Snapshot 屏障；TEX-61 的有界发送允许快照覆盖旧队列，使合法流被误报缺序。检查器改为按接收顺序处理认证/重连快照、独立快照和事件，用 bigint 校验屏障后的 S+1；缺序、重复、乱序、快照回退和仅有 RESYNC_REQUIRED 仍不能通过。

本地真实 PostgreSQL 16 + 生产入口，以失败 CI 的种子 SHA `868074e130e647d6a473e3b75fad4ca2e7e825fc` 运行默认 smoke（2 房间 × 4 玩家 × 90 秒）：修改前 77 个成功动作、24 个序列违反，判定失败；修改后仍为 77 个成功动作、序列/其他不变量/HTTP 5xx/崩溃均为零，判定通过。两次均未缩减负载。原验收中的数据库跳过描述仍对应此前全量测试；本次只补充真实链路 smoke 证据，不代表所有数据库集成已运行或正式容量验收。

`pnpm exec vitest run tests/performance`：9 个文件、83 项通过；新增 8 项序列回归在旧实现下有 5 项失败。目标文件 ESLint、`tsc --noEmit -p tsconfig.test.json`、Prettier、文档本地链接和差异空白检查通过。CLI 输出脱敏功能计数；CI 上传隐藏产物目录时显式 include-hidden-files，Git 忽略本地产物。

同步压测 README、Workflow README、06 测试策略及本记录。01–05 业务规格、任务范围/路线图与运维/安全说明已检查，无需更新：本次仅修正测试对既有协议的校验及证据交付，没有改变运行时、授权或日志字段。
