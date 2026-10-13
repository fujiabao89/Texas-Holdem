# TEX-62：牌局时序与弱网回归门禁实施卡

开始：2026-10-09；完成组合候选验收：2026-10-13。任务：[TEX-62](https://linear.app/texas-holdem/issue/TEX-62)。实现分支：`test/TEX-62-game-timeline-network-regression`。

**状态：门禁已实现，组合候选 afb0d1ae 曾完整通过 PR 9/9、RC 20/20 与审计；最终提交复验另检出慢接收注入未生效，现补齐有界真实响应放大，完整门禁结果以 PR #80 当前 SHA 为准。** 用户已授权分别修复 TEX-61/TEX-35，产品修复与门禁保持独立 PR。本卡给出真实链路证据与历史失败映射；测试要求的唯一权威来源为 [06 §9.3](../06-testing-strategy.md#93-tex-62-牌局时序与弱网真实链路门禁实施要求)。后续合并/发布候选须按自己的完整 SHA 冻结复验。

## 负责人、依赖与目录边界

- 用户在本任务明确“你来完成”，将测试实现委派给 Codex；用户保留产品范围、外部系统写入与发布的最终决策。
- 核对基线：`origin/main` 的 `e6e5eb47`，已包含 TEX-59（PR #59）、TEX-60（PR #69）、TEX-61（PR #71）。Linear 三项均为 Done；TEX-35 仍为 Todo。每次交付重新记录基线 SHA 与依赖状态。
- 可以先在该基线编写复现测试、运行并收集失败；TEX-35 的跨手展示修复交接前，不得宣称全部验收通过，也不能将失败改成 skip/xfail。
- 实现范围：`tests/e2e/real`、测试专用网络代理/诊断夹具、必要的 `tests/meta` 守护、根测试脚本和 `.github/workflows` 的门禁接线，以及对应 README/工程说明。不要在其他 Agent 的未交接工作区开发。
- 产品缺陷归属 TEX-35/59/60/61；在本卡记录最小复现、关联任务及阻断影响，不捎带修改前端生命周期、服务端编排、协议或扑克规则。本次经用户委派增加只读 DOM handId/发牌实例属性，未改变队列、准入或 wire。

## 四类用户问题与稳定复现入口

| ID | 问题与触发步骤 | 必须采集的观察与回归判断 | 归属 |
| --- | --- | --- | --- |
| R1 | 15 秒配置；完成普通摊牌后持续观察旧手结算、下一手发牌、行动开放三个边界 | 服务端阶段/时钟、真实 Snapshot 与浏览器控件；展示窗口不消耗下一手时间，开放点建立完整时长；判断方法见 06 §9.3 | TEX-59 |
| R2 | 六人多次快速结束牌局，积压队列后进入 Hard Forward；分别以正常、低帧率、Reduced Motion 和后台恢复运行 | 连续 DOM/动画观察及截图；结算不得无提示消失，不得与另一手操作混帧；快进必须有提示与正确语义终态 | TEX-35 |
| R3 | 在旧手结算与新手发牌边界断线，让正常客户端继续行动，再恢复并收到权威 Snapshot | 恢复前后 handId/sequence、有效发牌消费与可操作手；不回放断线事件，不重复发牌，剩余时间不重置 | TEX-35/60/61 |
| R4 | 连续快速牌局跨过旧行动/展示截止点；单接收者施加延迟/抖动并停读，使旧回调/旧帧晚于新手到达 | HAND_STARTED、PHASE_CHANGED、AUTO_ACTION、TIMER_IGNORED 与帧摘要；新手只开一次，旧回调不得引发新手立即弃牌，正常接收者继续推进 | TEX-59/61 |

这些要求已落为真实测试；当前基线的普通摊牌事件丢失已复现，其他结论须以实际运行记录为准。实施者须为每项提供历史缺陷基线或测试专用故障变体的失败证据，再给出修复基线的通过证据；不能伪造服务端 Event/赢家来制造所谓复现。真实线程调度无法稳定触发旧 Timer 时，应引用 TEX-59 的确定性单元用例作为补充，并保留浏览器连续跨手断言，不能将两者混记为端到端复现。

## 分批交付与运行入口

1. 先建真实链路观察器与证据采集，覆盖每个 BrowserContext，保证服务器/代理日志在退出前 flush；用已知敏感测试值验证导出脱敏。保持现有真实 PostgreSQL schema 隔离和 `retries: 0`。
2. 完成 R1–R4 与两人正常/弃牌获胜回归，再增加六/十人、全下、边池、平分、无人可操作场景。固定 seed 加合法 UI 动作脚本；对目标牌型/池结构先断言场景确实发生，不能在没走到目标分支时给出通过。
3. 加入四档 RTT、抖动、短暂断网、慢接收和展示降级；将 06 §9.3 的 PR/RC 矩阵接入门禁。测试专用代理故障计时可以使用真实定时器，业务断言等待可观察条件。
4. 用同一候选 SHA 运行 RC，生成验收表和失败台账，回填 TEX-30/43/56 发布证据；完整通过并完成文档同步后才申请 TEX-62 完成。

当前运行入口：

```powershell
$env:TEX_TEST_DATABASE_URL = '<隔离测试 PostgreSQL 连接串>'
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e:timeline       # PR：9 项
pnpm test:e2e:timeline:rc    # RC：20 项；Linux 用 xvfb-run -a
```

环境：Node 22+、仓库固定 pnpm、真实 PostgreSQL；服务端/前端默认端口 3201/3202，可用 `TEX_E2E_REAL_SERVER_PORT`/`TEX_E2E_REAL_WEB_PORT` 隔离。洗牌使用 `TEX_E2E_REAL_SEED`，缺省 280820；记录实际 seed、场景建房次序与派生信息。不要复用生产数据库，也不要提交连接串。

`@timeline-pr` / `@timeline-rc` 筛选已接线，`run.ts` 校验 PR 9 项、RC timeline 18 + split 1 + background 1，跳过/缺失/失败/flaky 均不能通过。CI check 为 `e2e-timeline`；手动 `Timeline release gate` 用完整 SHA 在同一候选运行 RC。证据位于 gitignore 的 `.artifacts-timeline`，关闭原始 trace/页面快照，仅保存白名单诊断、元数据与遮盖牌面的截图/录像。各套件 seed/人数/降级/浏览器映射见 [运行说明](../../tests/e2e/real/timeline/README.md)。

## 验收交接模板

每行包含：场景 ID、候选 SHA、依赖修复 SHA、seed/动作脚本、人数、浏览器/视口、降级条件、网络脚本与实测、目标分支命中、断言数、通过/失败/阻断、产物索引、缺陷任务。另列 R1–R4 的失败基线与修复后证据。

交付必须报告实际命令、首次执行结果、失败及诊断重跑（分开记）、未覆盖项、README/规格同步和原始审查线程闭环。TEX-30 接收自动门禁总表；TEX-43 接收候选版本、环境与回滚后的复测；TEX-56 接收真实移动设备/多人复玩证据。桌面 CDP、模拟移动视口或代理网络不替代移动实机/公网验收。

## 实测记录与阻断（持续回填）

环境：Windows、Node 22.22.0、PostgreSQL 16.15，本地独立数据库与 3261/3262 端口；生产装配服务端、真实三个浏览器、未提交工作区。HEAD 为上述基线，报告的 worktreeDirty 为 true，不能将本次开发验证当作该 HEAD 的不可变发布证据。

- 新增网络代理/证据负例与入口自测：27 项通过；测试 TypeScript 和定向 ESLint 通过。真实 E2E 首轮开发诊断修正了浏览器脚本引用 Node 变量、热更新 WS 被误当作牌局消息、JSON 报告相对路径与驱动等待缺失派奖的问题；这些重跑不计为候选门禁首次通过。
- R1 真实最小复现：两人、15 秒、seed 280820、合法 check/call 到普通摊牌。两名客户端均收到 sequence 21 的 PLAYER_CHECKED，随后直接收到 sequence 25 的 SHOWDOWN_DISPLAY Snapshot；22–25 的 SHOWDOWN_STARTED、PLAYER_REVEALED、POT_AWARDED 未收到。服务端进入展示窗口但浏览器缺少完整结算事件。定位到 TEX-61 普通 GAME_SNAPSHOT 清空发送队列中的未完成 GAME_EVENT；正常连接也会触发。不得以 Snapshot 命中代替结算分支断言。
- 10 月 9 日首次 PR 9 项中 2 通过、7 失败；首轮 RC 20 项中 4 通过、16 失败（包含当时测试夹具/后台环境问题，不作为最终缺陷数量）。10 月 12 日已将时序前端改为 production build/start，补齐 xfail/重试/浏览器替换拒绝、被停读玩家定向日志、真实 Token/牌面导出审计和进程→schema 清理顺序；复跑又查出既有 run-identity 夹具在中断后保存旧身份、配置却使用新 schema 的不一致；已改为配置使用返回的实际身份并增加隔离临时文件单测，拒绝不同端口并发。只清理本次日志明确记录的 4 个中断 schema，未清理其他命名空间。最终完整复测在交付前回填。独立原生浏览器探针在本机切换同窗标签、最小化与移除默认焦点模拟后仍返回 visible，后台能力未验证，不得记为通过。TEX-35 尚未完成，时序展示失败保持阻断；没有 skip/xfail，没有重试通过放行，也没有降低背压阈值。

## 2026-10-12 初始基线冻结复测（历史失败）

候选代码 SHA：`ba4f77cc7c40a50e20b40295ef6401ca6b727936`（包含 `8de6a3bb` 门禁实现）；全部证据 worktreeDirty=false。下面记录冻结版本的完整执行，先前开发诊断不与本轮混记。

| 验证命令 | 实际结果 |
| --- | --- |
| `pnpm exec vitest run --project unit tests/support/network-proxy.test.ts tests/support/timeline-evidence.test.ts tests/support/run-identity.test.ts tests/meta/test-entrypoints.test.ts` | 4 文件 / 27 项通过 |
| `pnpm exec tsc --noEmit -p tsconfig.test.json`、`pnpm typecheck` | 通过 |
| 定向 ESLint、`pnpm lint` | 通过；仅既有 gateway-protocol.test.ts unused room 警告 |
| `pnpm test:e2e:timeline` | 完整 9 项，0 通过 / 9 失败；skipped=0、flaky=0、runnerErrors=[]；退出 1 |
| `pnpm test:e2e:timeline:rc` | 完整 20 项（18+1+1），0 通过 / 20 失败；零 skip/xfail/重试，三个报告 runnerErrors=[]；退出 1 |
| `pnpm exec tsx tests/e2e/real/timeline/audit.ts` | 227 个文件通过脱敏审计 |
| 文档链接、`git diff --check` | 15 份 Markdown / 288 个本地链接与锚点通过；diff 通过 |

PR 服务端 ACTION_OPEN 窗口实测 14,999–15,000ms；浏览器 pageerror/未处理 console/HTTP 5xx 列表全部为空。恢复 deadline、同序列快照与弱网注入前置断言已到达；整个用例仍因结算缺失/过早消失失败，不能将局部断言通过记为门禁通过。

| 档位 | 浏览器 | 场景 | 结果 | 实际阻断 |
| --- | --- | --- | --- | --- |
| PR | chromium | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| PR | chromium | 弱网 500ms RTT：真实传输抖动不重置倒计时 | failed | 结算摘要不足最低 1 秒 |
| PR | chromium | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| PR | chromium | 六人Reduced Motion全下：公开摊牌、守恒与无人可操作终局 | failed | 全下派奖总额为 0（期望 120） |
| PR | chromium | R2 六人Reduced Motion跨手：合法弃牌快局后仍可操作 | failed | 结算摘要不足最低 1 秒 |
| PR | firefox | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| PR | firefox | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| PR | webkit | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| PR | webkit | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| RC | chromium | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| RC | chromium | 弱网 50ms RTT：真实传输抖动不重置倒计时 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | 弱网 100ms RTT：真实传输抖动不重置倒计时 | failed | 页面缺少已收到的权威派奖结果 |
| RC | chromium | 弱网 300ms RTT：真实传输抖动不重置倒计时 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | 弱网 500ms RTT：真实传输抖动不重置倒计时 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| RC | chromium | 六人Reduced Motion全下：公开摊牌、守恒与无人可操作终局 | failed | 全下派奖总额为 0（期望 120） |
| RC | chromium | R2 六人Reduced Motion跨手：合法弃牌快局后仍可操作 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | R3 SHOWDOWN_DISPLAY边界断网恢复：最新Snapshot不补播旧手 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | R3 DEALING边界断网恢复：最新Snapshot不补播旧手 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | 十人移动视口连续快局：Fold-to-win不虚构摊牌，不混手 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | R2 六人真实低帧率：降级后结算/下一手语义终态 | failed | 结算摘要不足最低 1 秒 |
| RC | chromium | 六人先弃牌再全下：真实主池/边池分配 | failed | 未收到边池分配，目标分支未验收 |
| RC | chromium | 慢接收真实背压：停读原生TCP，超限恢复不阻塞正常玩家 | failed | 结算摘要不足最低 1 秒 |
| RC | firefox | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| RC | firefox | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| RC | webkit | R1/R4 双人15秒：正常摊牌→连续三手→完整行动时钟 | failed | 缺少普通摊牌事件 |
| RC | webkit | R3 行动中断网：正常玩家继续推进，重连Snapshot保留原deadline | failed | 页面缺少已收到的权威派奖结果 |
| RC | chromium | 固定seed双人平分：每Pot金额守恒且每手只结算一次 | failed | 未收到平分分配，目标分支未验收 |
| RC | chromium | R2/R3 真实窗口后台与恢复：不补播旧手，Snapshot回到当前可操作手 | failed | 本机原生 hidden 能力预检失败 |

阻断归属：普通摊牌/全下/边池/平分末尾事件被普通阶段 Snapshot 清空，关联 TEX-61；已收到的派奖摘要缺失或不足 1 秒，关联 TEX-35。边池和平分未收到目标派奖帧，因此不宣称目标分支验收通过。后台原生能力在本机没有产生 hidden，预检明确失败，不造假或 skip；Linux/Xvfb 尚未执行。上述 P1 与环境未验证状态阻断 TEX-30/43/56 发布证据通过。

产物：工作区 `tests/e2e/.artifacts-timeline/gate.json` 与各场景 `results.json`；每项包含脱敏 timeline-evidence、失败截图/录像、真实网络采样与白名单服务端日志。PR 全目录独立归档 `C:/tmp/tex62-pr-ba4f77cc`，35 个附件路径已重定位并验证存在。正式受控 Release 档案仍由发布负责人保存，未上传外部系统。

资源清理：PR 与三个 RC schema 均已 DROP；本轮身份文件已删除，3261/3262 无监听，数据库没有其他 client backend。严格 PID/schema 身份校验成功，未出现额外执行器错误。原始用户工作区的未交接修改保持原样。

## 初始基线文档同步判断（历史记录）

- 已同步测试目录 README、support/meta、工作流 README、05 前端只读观测契约、06 测试权威规格与项目/工程/总索引。本任务卡记录用户委派、实际入口及缺陷阻断。
- 01/02/03/04 权威规格、产品玩法/规划、权限与持久化：已检查，无需更新，测试不改变扑克规则、wire 或数据库结构。安全/运维规范的原始敏感数据禁入与 180 天 Release 保留仍适用；GitHub 90 天 RC 产物需转存受控 Release 档案，已在工作流 README 说明。
- 本地提交已完成；Linear 写入、推送、PR 创建与发布尚未执行；未改变任务 Todo 状态。尚无 PR 审查意见需要回复，不自动启动 Greptile 或 DeepSeek Harness。

## 授权修复与最终候选复验（2026-10-12）

- TEX-61 独立分支 `fix/TEX-61-preserve-phase-event-order`：普通阶段快照保留完整事件批次，40 项网关单测通过。
- TEX-35 独立分支 `fix/TEX-35-stabilize-cross-hand-animation`：阶段快照保留连续语义展示，跨手结果从实际绘制开始至少显示一秒，旧手展示隐藏新手操作/时钟；恢复只静态呈现同手已授权结果。50 项动画/投影单测通过。
- 门禁分支基于上述依赖交付，PR diff 只包含测试/CI、对应文档与只读 DOM 属性。用户保留合并和生产发布决定；仓库既有 Preview 检查按其配置运行。
- 冻结诊断候选 `40264efa` 的 RC：时序 17/18、平分 1/1 通过，后台 0/1（本机原生 hidden 预检失败）；零跳过、零重试、无 runner error、worktreeDirty=false。300ms 失败实际来自网络夹具对分块独立设定定时器导致乱序，128 块真实 TCP/seed 62 已复现旧实现失败；单一 FIFO 泵修复后完整保序。
- 最终代码候选 `d61d477f` 已修复代理、UTF-8 观察及完整终局批次驾驶，并补齐后台同手静态恢复。此前完整 unit 95 文件/987 项通过，lint/typecheck 通过；新增回归与最终完整门禁结果以交付时的 gate.json/CI 固定 SHA 证据为准。
- 首次接入 RC Workflow 尚未进入 main 时，使用 TEX-62 草稿 PR 的 `timeline-rc` 标签入口，在 PR head 的完整 SHA 上执行同一 20 项 Linux/Xvfb 门禁；不依赖先合并 Workflow，不使用生产秘密。
- 旧失败矩阵保留为历史缺陷证据；最终结果另行追加，不以删除失败、降低阈值或重试掩盖阻断。

## 2026-10-13 最终组合候选验收

不可变代码候选：`afb0d1ae64a2c42c1893a2c5d55bb66574171e62`，所有报告 worktreeDirty=false。依赖修复为 TEX-61 `259ccc0ed49ed9a797d366629417dbb88aa5165a` 与 TEX-35 `4163e30e`（含展示修复 `c054d5c7`）。交付顺序：[TEX-61 PR #78](https://github.com/fujiabao89/Texas-Holdem/pull/78) → [TEX-35 PR #79](https://github.com/fujiabao89/Texas-Holdem/pull/79) → [TEX-62 PR #80](https://github.com/fujiabao89/Texas-Holdem/pull/80)；合并依赖后依次调整 base，合并提交仍需适用 CI。

| 命令/检查 | 固定候选实际结果 |
| --- | --- |
| `pnpm test:unit` | 95 文件 / 994 项通过 |
| `pnpm typecheck`、`pnpm lint` | 通过；lint 仅既有 gateway-protocol.test.ts unused room 警告 |
| `pnpm test:e2e:timeline`（Windows） | 完整 9/9；Chromium 5、Firefox 2、WebKit 2；零 skip/xfail/retry/flaky，runnerErrors=[]；退出 0 |
| `pnpm test:e2e:timeline:rc`（Linux/Xvfb） | 完整 20/20：timeline 18（14+2+2）、split 1、真实 background 1；每项只运行一次，零 skip/xfail/retry/flaky、三个报告 runnerErrors=[]，gate.validReport 均 true；退出 0 |
| `pnpm exec tsx tests/e2e/real/timeline/audit.ts` | 本地 PR 5 文件、RC 9 文件通过；CI 上传成功 |
| 文档与差异 | 23 份 Markdown / 457 个本地链接与锚点通过；`git diff --check` 通过；最终文档提交再次核验 |

[完整 RC CI run 38337382032](https://github.com/fujiabao89/Texas-Holdem/actions/runs/38337382032) 的 artifact ID 为 `11785701131`，ZIP SHA256 为 `54905f501e58ceebadbcf7ed07a4627b6c80aa103b52f1abe6292f8fde7f4d00`。产物含 gate.json、三个 results.json、白名单日志及内嵌每玩家证据；均已下载复核。GitHub 90 天保留，后续正式 Release 仍按 06 转存受控档案。

四类回归已命中：R1/R4 正常摊牌和连续三手完整行动窗口；R2 Reduced Motion/低帧率/跨手展示与混手隔离；R3 行动、摊牌、发牌边界断网恢复及同序列快照；R4 延迟、抖动、真实慢接收隔离。全下、无人可操作、主池/边池、平分、Fold-to-win 及十人移动视口分支均执行真实合法 UI 动作，并以服务端公开分配对照 DOM。后台原生 host DOM 记录 visible/hidden，恢复取得 fresh Snapshot，无旧手补播。陈旧 Timer 拒绝的确定性证明仍引用 TEX-59 unit，不冒充真实调度复现。

`4a2eef1d` 的完整 Linux RC 为 19/20，独立审计已通过；更强慢接收在 13,312 个合法 TIME_SYNC 探针后触发了持续控制积压恢复循环，观察器维持原 20,000 帧上限并正确阻断。TEX-61 补修先在旧码确定性失败，再完成 41 项网关验证。最终 RC 使用同样 13,312 个探针，只记录一次 RESYNC_REQUIRED，各玩家 63–77 个游戏/恢复帧、观测错误为零；硬限、年龄/事件数和恢复期限未调整。此前失败与诊断重跑保留，不与最终完整执行混记。

CI 报告曾自动捕获 config.metadata.gitDiff 并带入环境地址，上传审计正确拒绝；现显式关闭自动 Git 元数据和 diff，保留独立 SHA/dirty 来源。Firefox 关闭 context 前先等待页面关闭，真实 PR 两项通过。唯一 favicon.ico 404 作为辅助资源 warning 保留，其他资源/JS/游戏错误仍失败；favicon 缺失为任务外后续建议。

文档同步：已更新测试/支持/Workflow/只读 DOM 所在目录 README、05/06 规格、项目和工程索引及本卡；TEX-61/TEX-35 的模块 README 与 02/04/05 规格由各自 PR 同步。01/03、产品范围、安全和运维说明已检查，无需更新：本次未改变扑克规则、wire/数据库结构、权限、生产配置、日志字段或保留政策。上传审计仍 fail-closed；不启动 DeepSeek Harness 或 Greptile。截至本轮复核，三个 PR 无待处理原始审查评论线程。

资源：本地 PR schema 与 RC 三个 schema 均完成清理，身份文件删除；本地测试端口与数据库客户端无残留，原工作区的未交接修改保持原样。一次 about:blank 探针的空临时 profile `tex62-native-probe-kUmm0O` 因工具 policy 拒绝删除而保留，未复用用户浏览器会话；实际后台测试的独立 profile 已按所有权校验清理。

边界：自动门禁提供 TEX-30/TEX-43/TEX-56 的代码回归证据；真实移动实机、真人多人、公网、目标部署、容量/Soak、告警和回滚仍由对应发布任务验收。最终 PR 文档/产物名称提交的固定 SHA 门禁以 PR #80 当前 CI 产物为准；本记录保留上述完整代码候选的首次通过证据。


## 最终提交的注入稳定性复核（2026-10-13）

794f5380 的完整复验为 19/20，零重试/跳过，独立审计与后台/平分仍通过；慢接收实际发送 51,043 个校时探针，但部分请求尚在客户端/代理原生缓冲中，服务端压力未触发，故继续阻断。没有把上轮通过当作本轮通过。现每四个有界探针包含一个合法 REQUEST_SNAPSHOT，其余 TIME_SYNC；回复由生产投影生成，保持最多 65,536 探针与 256KiB 客户端缓冲，记录两类实际请求数量。目标仍必须观察本玩家真实背压、注入后恢复和正常玩家继续推进，未降低生产阈值、未伪造任何游戏帧。最新完整矩阵与产物绑定当前 PR head SHA；上述历史通过与失败均保留。
