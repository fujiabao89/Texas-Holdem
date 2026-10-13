# TEX-62 牌局时序与弱网门禁

本目录覆盖真实建房、合法 UI 行动、跨手展示与权威时钟。测试要求见 [06 §9.3](../../../../docs/06-testing-strategy.md#93-tex-62-牌局时序与弱网真实链路门禁实施要求)，实施与结果见 [任务卡](../../../../docs/00-project/TEX-62-regression-gate.md)。

```powershell
$env:TEX_TEST_DATABASE_URL = '<隔离测试 PostgreSQL 连接串>'
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e:timeline       # PR：9 项
pnpm test:e2e:timeline:rc    # RC：20 项，含有窗口的真实后台恢复
```

Node 22+、仓库固定 pnpm、PostgreSQL 16；时序配置每次先执行 Next production build（Webpack）再 start，排除 HMR 与运行中按需编译对 15 秒窗口的干扰。端口默认 3201/3202，可用 `TEX_E2E_REAL_SERVER_PORT`/`TEX_E2E_REAL_WEB_PORT` 修改。Linux RC 用 `xvfb-run -a`，本地 RC 要可用桌面。不得并发运行不同 real 配置。缺数据库/浏览器、故障未生效、报告缺失、少跑、skip、xfail、失败、重试与浏览器矩阵替换均失败；重试为零。后台先以原生标签激活核验真实 hidden→visible，移除 Playwright 默认焦点模拟；缺少该原生能力时明确失败，不伪造 visibility 或改成 skip。原生默认 context 已在 Windows 与 Linux/Xvfb 产生真实 hidden→visible；每轮仍必须重新通过能力预检。

| 场景 | 内容 | 执行 |
| --- | --- | --- |
| timeline | 双人普通摊牌、三手连续、同序列开放 Snapshot、行动期断网重连；六人全下 Reduced Motion | PR：Chromium 5 项，Firefox/WebKit 各 2 个关键恢复项 |
| timeline | 增加 50/100/300ms RTT（PR 已有 500ms）、十人移动视口、六人实际主线程低帧率、边池、真实停读背压 | RC：Chromium 14 项，Firefox/WebKit 各 2 项，共 18 |
| split | 两人合法 check/call 命中主池平分，再进入下一手 | RC：Chromium 1 项 |
| background | 有窗口的 Chromium，核验 hidden→visible、恢复 Snapshot 和下一手 | RC：Chromium 1 项 |

`run.ts` 顺序启动三个独立进程/schema，失败仍执行其他场景并使总门禁失败。`split` 首场 seed 默认 280835，其余 280820；不要为 RC 覆盖 seed，否则平分分支可能未命中而正确失败。服务端在同一进程按 tournament 序号派生 seed，固定串行建房顺序。诊断筛选可直接使用 `pnpm exec playwright test -c tests/e2e/playwright.timeline.config.ts --project chromium --grep 'R1/R4'`；筛选执行不算完整门禁。

`fixture.ts` 为每名玩家创建独立 BrowserContext/TCP 代理并观察原生 WS、DOM Mutation、animationstart 和 rAF；观察数据仅写入测试页面自己的命名空间，不改产品 store。代理每方向 RTT/2，保持字节顺序，记录实际转发耗时；停读作用于上游 TCP，而非拦截 JS onmessage。压力用例发送有界合法 TIME_SYNC/REQUEST_SNAPSHOT，不修改生产背压阈值；只接受被停读玩家本人的背压日志和注入后恢复帧。后台玩家停止 UI 出牌，使用真实服务器超时，其他玩家继续合法 UI 操作；后台旧手不补播，恢复后核验最新 Snapshot。

证据位于 `tests/e2e/.artifacts-timeline/`（gitignore）：`gate.json` 总结果、各场景 `results.json`、每名玩家的事件元数据/DOM/帧间隔/网络采样、白名单服务端日志。失败保留遮盖所有牌面的截图/录像，成功删除录像。每条证据在导出前核验本次真实 playerToken、连接串与牌面/原始 Payload 结构；独立 audit.ts 再审查整个产物目录，审计失败禁止 GitHub 上传。timeline global-teardown 校验 runId 派生 schema 与 application PID，仅停止本次测试子进程，再删除隔离 schema，避免先强制断 DB 导致日志展开连接对象。关闭原始 trace 与 Playwright 自动页面可访问性快照（`PLAYWRIGHT_NO_COPY_PROMPT`），不导出原始事件 Payload、认证 URL、牌面或连接串。报告记录 HEAD 与工作区是否有未提交修改，未提交验证不能冒充已提交候选 SHA 的发布证明。

真实旧 Timer 回调的确定性拒绝由 TEX-59 runtime 单测补充；E2E 断言实际 AUTO_ACTION 不早于当前 deadline，不能因未出现 TIMER_IGNORED 就宣称已触发旧回调。桌面移动视口、代理网络与 Xvfb 后台不替代 TEX-56 移动实机/公网/人工多人复玩。GitHub 产物保留及受控 Release 档案要求见 [工作流 README](../../../../.github/workflows/README.md)。

TEX-62 复验修正：终局事件接收先于语义展示完成，因此验收等待 DOM 中每项权威分配实际出现（最多 45 秒），随后仍执行最低停留/混手/重复发牌校验。首手闭合行动状态可能由重连 Snapshot 提供，R1 对照同 handId/sequence 的先前 GAME_SNAPSHOT 或 RECONNECT_RESULT 与行动开放 Snapshot，不要求额外广播同内容帧。

TEX-62 的 `websocket-text.ts` 对 Playwright 1.62 Firefox Juggler 观察器返回的 Latin-1 字节串执行严格 UTF-8 解码；Chromium/WebKit 原生文本不转换，异常编码明确失败。只修复被动测试观察，不修改应用消息。单测覆盖中文/Emoji/希腊字母、ASCII、Buffer 和非法字节。公开派奖证据只导出 handId、玩家 ID/测试昵称和金额，不导出牌面或原始 payload。

首次接入的 RC Workflow 尚未出现在 main 时，可以给 TEX-62 PR 添加 `timeline-rc` 标签，在该 PR 的完整 head SHA 上启动同一 20 项门禁（Linux/Xvfb，零重试）；不依赖先合并 Workflow。此入口只用 contents:read 与隔离测试数据库，无生产秘密。PR head 更新会重新运行；日常 9 项 PR 门禁仍由 CI 的 main 目标 PR 执行，依赖分支合并后应依次调整 PR base。

终局驾驶按完整批次边界计数：普通摊牌等待 GAME_SNAPSHOT/RECONNECT_RESULT 的终局状态；Fold-to-win 等待下一手 HAND_STARTED，最终手等待 TOURNAMENT_FINISHED。SHOWDOWN_STARTED Patch 的 HAND_END 和第一条 POT_AWARDED 都不能提前完成目标，确保多 Pot 分配已收齐。hand-boundary 单测覆盖该竞争；真实目标分支仍显式校验权威分配，恢复 Snapshot 不可掩盖缺失事件。

代理回归修正：每方向只由一个定时 FIFO 泵写出 TCP 块，计时到期后只从队头排空；遵守真实 write/drain 背压，resumeReads 不覆盖未解除的写压力。128 个真实分块、RTT 300ms/抖动 149ms/seed 62 的旧实现出现字节乱序，新实现完整保序。恢复到下一手 Snapshot 也可确认已收到派奖的上一手结束，分配分支仍独立校验。

真实后台主玩家使用独立空临时 profile 启动 Chromium，再通过公开 connectOverCDP(noDefaults:true) 连接默认 context，避免 Playwright 的默认焦点模拟覆盖原生 visibility。仅切换真实标签，不改写 document.hidden/visibilityState。主玩家以连续 DOM 与失败遮牌截图提供证据（不启用会干扰后台的自动录屏），其余玩家沿用遮牌录像；关闭后验证绝对 profile 属于本任务临时目录再清理。原生探针已证明 hidden→visible。UI helper 可接收显式 baseURL，避免默认 context 依赖自动配置。

代理按方向在 256KiB 暂停读取、128KiB 以下恢复，并继续遵守 write/drain 和外部停读；2MiB 原生回环突发保持完整字节且不触发代理自身 1MiB 硬上限。生产服务端阈值不变。上传审计仍拒绝不安全产物，仅打印受控相对文件名，便于定位 CI 捕获问题。

原生浏览器会请求当前应用未提供的 favicon.ico；独立无身份 create 页面探针已确认唯一资源错误为该辅助图标 404。夹具将精确 favicon 404 保留为 warnings 证据（已记录为任务外资源建议），脚本/API 失败、5xx、JS 异常和游戏观测错误继续阻断。不忽略其他 404。

CI 关闭 Playwright 的自动 Git 元数据和 source diff 捕获：Git diff 可能含环境连接串，候选 SHA/dirty 状态由门禁自行记录，独立上传审计保持 fail-closed。Firefox 在移除 context 前等待页面关闭，避免容器移除与 SessionStore 窗口清理竞态；关闭错误仍使测试失败。慢接收用例以最多 65,536 个合法探针分批填充真实内核缓冲，四分之一使用 REQUEST_SNAPSHOT，其余 TIME_SYNC，客户端发送缓冲上限 256KiB；只在目标玩家的生产背压日志出现后停止，未触发则失败。小校时回复在 Linux 大内核缓冲下可能无法及时形成背压，因此真实接收者 Snapshot 请求提供有界响应放大，不伪造游戏帧或降低生产阈值；记录实际两类请求数量。校时回复逐条通过协议验证，只汇总数量与有界 RTT 样本，不占用牌局序列记录。
