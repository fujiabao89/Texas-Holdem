# TEX-49 验收记录

日期：2026-10-26。任务：[TEX-49](https://linear.app/texas-holdem/issue/TEX-49)。分支：`feat/TEX-49-result-lobby-next-round`，基于主线 `b3d7dafb`。用户委派 Codex 继续完成本任务；原工作区未提交改动保持原状。

## 交付范围

- 结果页仅当前房主在 FINISHED 可执行 REOPEN_LOBBY，携带当前 revision；接受 RoomSnapshot 后进入同一筹备大厅，不创建比赛。LOBBY 的现有成员可返回，IN_GAME 的旧结果可前往牌桌。权限跟随最新 hostPlayerId。
- Lobby 展示在线/入座/Ready，未入座者单列；至少两名 P0 真人且所有保留成员在线、入座、准备，无活跃比赛且无本地未完成操作时，房主才可开局。逐成员说明阻塞原因，保留踢人能力。
- 邀请码仅 LOBBY 展示/复制；比赛/结果阶段暂停加入；CLOSED 显示永久失效，优先于因关闭清理凭证后的“缺少身份”提示。
- 控制面同步锁、相同 payload 幂等重试、过期 revision 重新认证、卸载取消及单调 RoomSnapshot 消费；Ready 回执不改成员状态。新比赛的 Room/Game ID 匹配后再自动进入牌桌，沿用既有快照动画屏障。
- 旧赛果按 tournamentId GET/缓存，增加同场历史入口；历史仅在请求场号等于实时场号时显示本手事件，下一场不能混入上一场。
- 删除 TEX-48 临时 HTTP 桥接，真实测试从新页面按钮重开；首场双人，下一场邀请第三名玩家加入并重新准备。

## 验证

| 命令/检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 通过，无依赖变更 | 独立工作区安装 |
| `pnpm exec vitest run --project unit apps/web/src/features/lobby apps/web/src/features/result apps/web/src/features/hand-history apps/web/src/protocol apps/web/src/state/projection-store.test.ts apps/web/src/messages` | 10 文件，109 项通过 | 状态/权限/邀请、HTTP/WS、投影及历史模型 |
| `pnpm typecheck`；`pnpm lint` | 通过 | 存量 gateway-protocol.test.ts 未使用变量 warning 保留，无错误 |
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round create-room --workers=2` | 17 项通过 | 新闭环和原创建/加入、品牌、历史焦点、手机赛果 |
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round --workers=2` | 7 项通过 | 最终历史场号隔离、axe serious 扫描与新增闭环 |
| Chromium：real 配置下 multiplayer-journey/result-recovery，grep 双人完整/多轮共存 | 2 项通过 | 真实浏览器→HTTP/WS→生产 game-server→独立 PostgreSQL schema；新比赛数量/ID、外部第三人、旧赛果刷新 |
| real 配置下 multiplayer-journey/result-recovery，grep 双人完整/多轮共存（Chromium/Firefox/WebKit） | 最终 6 项通过，重试 0 | 三浏览器真实第二轮与旧赛果刷新；删除多余导航后的完整复验 |
| real accessibility：Firefox/WebKit，grep 键盘 | 2 项通过 | 纯键盘流程与关键页面 axe 扫描 |
| `pnpm --filter @texas-holdem/web build` | 通过 | Next.js 16.3.6 生产编译、TypeScript 和全部路由生成 |

真实链路使用仅 loopback 的独立临时 PostgreSQL，每次套件创建并清理 `tex_e2e_real_*` schema，不连接生产数据。既有 real teardown 在结束时终止应用连接，出现 pg Pool 的 57P01 日志；用例均通过、schema 已删除，此处不修改服务端或 teardown。初次并发启动两套 Next dev 被同工作区锁拒绝后，改为串行运行；不将启动失败计为测试通过，也未设置重试。

## 文档同步检查

已更新 Web、result、lobby、hand-history、features、messages、app 与测试 README、05/06 权威规格和项目/工程/总索引。本任务不增加协议、服务端、数据库或扑克规则；02/03/04 权威规格、数据迁移、安全/运维说明及部署配置：**已检查，无需更新**，原因是沿用 TEX-48 的认证/状态机/接口及 TEX-54/55 的只读结果/历史端点。

浏览器诊断门禁保留：首次 Firefox/WebKit 扩展运行共 6 项，5 通过、WebKit 多人旅程在业务断言全部完成后因 RSC 导航失败/开发栈帧访问错误被门禁拒绝。测试仍残留重开后整页 goto 同一大厅、自动入桌后再 goto 大厅的旧步骤；现已删除这些多余导航，成员直接经结果页返回链接进入筹备大厅，再运行全三浏览器的两项关键用例。未增加白名单、未启用重试，最终结果在上表回填。

## 风险与交付边界

- 真机、多设备公网与发布体验验收仍由 TEX-56 承担；桌面浏览器或受控视口不替代手机实机。
- 不更改既有结果持久化路径的限制，见 TEX-54 验收记录；不修改引擎、服务端裁决或协议版本。
- 本任务未处理现存 PR 审查评论，故无“已修正”线程回复。未调用 DeepSeek Harness 或触发 Greptile。
- 仅交付可审查 PR，合并与部署由用户决定。

## PR #85 时序检查修复

用户报告 [e2e-timeline 失败](https://github.com/fujiabao89/Texas-Holdem/actions/runs/40317676432/job/121554252253?pr=85)。该次 9 项中 R1/R4 在 Chromium/Firefox/WebKit 均失败，其余 6 项通过。产物证明首手 sequence=1～7 的事件到达时客户端尚无 GameSnapshot 基线；首份完整快照已经是 ACTION_OPEN（sequence=7、deadline 非空），而非此前发牌闭合状态，不能把此失败归为网络抖动或放宽断言。

修复 Lobby 的恢复触发：IN_GAME 新场号与现有 GameSnapshot 不匹配时，立即通过原 WebSocketTransport 对该新场号重新认证一次，恢复初始权威 Room/Game 快照，再执行原匹配后入桌流程。旧场和缺失场均不作为新事件基线；既有连接重试继续由 Transport 管理。不修改扑克规则、服务端、协议、Timer、门禁断言或 CI 配置。

补充受控回归模拟只发送新 RoomSnapshot、不主动发送 GameSnapshot，要求立即恢复并进入牌桌，精确核验认证次数，禁止依赖延迟的 ACTION_OPEN。8 项 next-round 浏览器回归通过；Web lint/typecheck、定向 E2E ESLint 与根测试类型检查通过；`TEX_TEST_DATABASE_URL=<独立 loopback 库> pnpm test:e2e:timeline` 完整 9 项通过（Chromium 5、Firefox 2、WebKit 2，零重试），`gate.json` 为 passed=true、exitCode=0、expectedCount=9、validReport=true。该本地执行使用未提交候选，明确保留 worktreeDirty=true；提交后以 GitHub 同名检查确认候选 SHA。

该失败来自 Actions 检查，没有对应的原始 PR 审查评论线程；无需构造“已修正”评论或回复其他审查线程。相关目录 README 与 05 规格已同步；协议、服务端、数据库、安全/运维与 CI 配置已检查，无需更新，因为修复限于使用既有认证屏障的前端时机。
