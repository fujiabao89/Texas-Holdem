# TEX-62 牌局时序与弱网门禁

本目录覆盖真实建房、合法 UI 行动、跨手展示与权威时钟。测试要求见 [06 §9.3](../../../../docs/06-testing-strategy.md#93-tex-62-牌局时序与弱网真实链路门禁实施要求)，实施与结果见 [任务卡](../../../../docs/00-project/TEX-62-regression-gate.md)。

```powershell
$env:TEX_TEST_DATABASE_URL = '<隔离测试 PostgreSQL 连接串>'
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e:timeline       # PR：9 项
pnpm test:e2e:timeline:rc    # RC：20 项，含有窗口的真实后台恢复
```

Node 22+、仓库固定 pnpm、PostgreSQL 16；时序配置每次先执行 Next production build（Webpack）再 start，排除 HMR 与运行中按需编译对 15 秒窗口的干扰。端口默认 3201/3202，可用 `TEX_E2E_REAL_SERVER_PORT`/`TEX_E2E_REAL_WEB_PORT` 修改。Linux RC 用 `xvfb-run -a`，本地 RC 要可用桌面。不得并发运行不同 real 配置。缺数据库/浏览器、故障未生效、报告缺失、少跑、skip、xfail、失败、重试与浏览器矩阵替换均失败；重试为零。后台先以原生标签激活核验真实 hidden→visible，移除 Playwright 默认焦点模拟；缺少该原生能力时明确失败，不伪造 visibility 或改成 skip。Windows 本次环境未能产生 hidden，完整 RC 保持阻断，Linux/Xvfb 需独立验证。

| 场景 | 内容 | 执行 |
| --- | --- | --- |
| timeline | 双人普通摊牌、三手连续、同序列开放 Snapshot、行动期断网重连；六人全下 Reduced Motion | PR：Chromium 5 项，Firefox/WebKit 各 2 个关键恢复项 |
| timeline | 增加 50/100/300ms RTT（PR 已有 500ms）、十人移动视口、六人实际主线程低帧率、边池、真实停读背压 | RC：Chromium 14 项，Firefox/WebKit 各 2 项，共 18 |
| split | 两人合法 check/call 命中主池平分，再进入下一手 | RC：Chromium 1 项 |
| background | 有窗口的 Chromium，核验 hidden→visible、恢复 Snapshot 和下一手 | RC：Chromium 1 项 |

`run.ts` 顺序启动三个独立进程/schema，失败仍执行其他场景并使总门禁失败。`split` 首场 seed 默认 280835，其余 280820；不要为 RC 覆盖 seed，否则平分分支可能未命中而正确失败。服务端在同一进程按 tournament 序号派生 seed，固定串行建房顺序。诊断筛选可直接使用 `pnpm exec playwright test -c tests/e2e/playwright.timeline.config.ts --project chromium --grep 'R1/R4'`；筛选执行不算完整门禁。

`fixture.ts` 为每名玩家创建独立 BrowserContext/TCP 代理并观察原生 WS、DOM Mutation、animationstart 和 rAF；观察数据仅写入测试页面自己的命名空间，不改产品 store。代理每方向 RTT/2，保持字节顺序，记录实际转发耗时；停读作用于上游 TCP，而非拦截 JS onmessage。压力用例发送有界合法 TIME_SYNC，不修改生产背压阈值；只接受被停读玩家本人的背压日志和注入后恢复帧。后台玩家停止 UI 出牌，使用真实服务器超时，其他玩家继续合法 UI 操作；后台旧手不补播，恢复后核验最新 Snapshot。

证据位于 `tests/e2e/.artifacts-timeline/`（gitignore）：`gate.json` 总结果、各场景 `results.json`、每名玩家的事件元数据/DOM/帧间隔/网络采样、白名单服务端日志。失败保留遮盖所有牌面的截图/录像，成功删除录像。每条证据在导出前核验本次真实 playerToken、连接串与牌面/原始 Payload 结构；独立 audit.ts 再审查整个产物目录，审计失败禁止 GitHub 上传。timeline global-teardown 校验 runId 派生 schema 与 application PID，仅停止本次测试子进程，再删除隔离 schema，避免先强制断 DB 导致日志展开连接对象。关闭原始 trace 与 Playwright 自动页面可访问性快照（`PLAYWRIGHT_NO_COPY_PROMPT`），不导出原始事件 Payload、认证 URL、牌面或连接串。报告记录 HEAD 与工作区是否有未提交修改，未提交验证不能冒充已提交候选 SHA 的发布证明。

真实旧 Timer 回调的确定性拒绝由 TEX-59 runtime 单测补充；E2E 断言实际 AUTO_ACTION 不早于当前 deadline，不能因未出现 TIMER_IGNORED 就宣称已触发旧回调。桌面移动视口、代理网络与 Xvfb 后台不替代 TEX-56 移动实机/公网/人工多人复玩。GitHub 产物保留及受控 Release 档案要求见 [工作流 README](../../../../.github/workflows/README.md)。

TEX-62 复验修正：终局事件接收先于语义展示完成，因此验收等待 DOM 中每项权威分配实际出现（最多 45 秒），随后仍执行最低停留/混手/重复发牌校验。首手闭合行动状态可能由重连 Snapshot 提供，R1 对照同 handId/sequence 的先前 GAME_SNAPSHOT 或 RECONNECT_RESULT 与行动开放 Snapshot，不要求额外广播同内容帧。

TEX-62 的 `websocket-text.ts` 对 Playwright 1.62 Firefox Juggler 观察器返回的 Latin-1 字节串执行严格 UTF-8 解码；Chromium/WebKit 原生文本不转换，异常编码明确失败。只修复被动测试观察，不修改应用消息。单测覆盖中文/Emoji/希腊字母、ASCII、Buffer 和非法字节。公开派奖证据只导出 handId、玩家 ID/测试昵称和金额，不导出牌面或原始 payload。
