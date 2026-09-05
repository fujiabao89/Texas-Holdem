# P0 任务卡：Web 前端、验证与发布

> 覆盖 Linear TEX-23 至 TEX-30。前端只展示服务端权威状态并提交请求，不能自行裁决扑克结果。

## TEX-23：前端基础

- **Linear / 分支**：[TEX-23](https://linear.app/texas-holdem/issue/TEX-23/feattex-23-bootstrap-web-app-and-client-transport) · `feat/TEX-23-bootstrap-web-app-and-client-transport`
- **主责**：Claude Code
- **前置**：TEX-17。
- **要做什么**：建立 Next.js 路由、i18n、客户端状态、HTTP/WS Transport、Snapshot/Event 消费和错误显示。
- **完成标准**：只使用 `src/app` 路由；不自行推导合法动作；缺序时重新同步；不显示 P1 AI/单人入口。
- **权威参考**：`docs/05-frontend-spec.md` §4～§6、§15、§17。

## TEX-24：首页与大厅页面

- **Linear / 分支**：[TEX-24](https://linear.app/texas-holdem/issue/TEX-24/feattex-24-build-home-create-join-and-lobby-flows) · `feat/TEX-24-build-home-create-join-and-lobby-flows`
- **主责**：Trae Work
- **前置**：TEX-19、TEX-23。
- **要做什么**：实现首页、创建/加入、邀请码、房间配置、选座、Ready 与房主操作。
- **完成标准**：权限正确、错误信息清楚、窄屏可用，并支持键盘、可见焦点和语义标签。
- **权威参考**：`docs/05-frontend-spec.md` §6.1～§6.4、§12、§14、§16。

## TEX-25：牌桌与下注页面

- **Linear / 分支**：[TEX-25](https://linear.app/texas-holdem/issue/TEX-25/feattex-25-build-responsive-poker-table-and-betting-controls) · `feat/TEX-25-build-responsive-poker-table-and-betting-controls`
- **主责**：Claude Code
- **前置**：TEX-21、TEX-24。
- **要做什么**：实现 2–10 人响应式 Seat、牌桌、Board、Pot、回合状态和下注控件。
- **关键点**：下注额度完全来自服务端 `LegalActions`；提供 BB/Pot 快捷额、Slider、精确输入与 All-in 二次确认。
- **完成标准**：手机常规下注无需键盘；非当前行动者不可提交；2/3/6/10 人布局和键盘操作合格。
- **权威参考**：`docs/05-frontend-spec.md` §7、§8、§11、§16。

## TEX-26：动画、音效与重连体验

- **Linear / 分支**：[TEX-26](https://linear.app/texas-holdem/issue/TEX-26/feattex-26-build-event-animation-audio-and-reconnect-ux) · `feat/TEX-26-build-event-animation-audio-and-reconnect-ux`
- **主责**：Trae Work
- **前置**：TEX-25。
- **要做什么**：实现 Event → AnimationQueue、发牌/翻牌/下注/Showdown 动画、基础音效和断线体验。
- **完成标准**：Burn Card 不翻开；Showdown 高亮最佳五张；重连不回放旧动画；慢动画不阻塞牌局。
- **权威参考**：`docs/05-frontend-spec.md` §9～§11、§16。

## TEX-27：赛果、设置与个人历史

- **Linear / 分支**：[TEX-27](https://linear.app/texas-holdem/issue/TEX-27/feattex-27-build-results-settings-and-player-hand-history) · `feat/TEX-27-build-results-settings-and-player-hand-history`
- **主责**：Trae Work
- **前置**：TEX-22、TEX-25。
- **要做什么**：实现赛果、再来一局、设置/规则、音效与动态偏好、当前玩家视角的 Hand History。
- **完成标准**：结果与服务端事件一致；历史、缓存和错误页不泄露其他玩家未公开底牌；不实现外部观战或账号战绩。
- **权威参考**：`docs/05-frontend-spec.md` §6.6～§6.7、§13、§17。

## TEX-28：联调 E2E 与安全测试

- **Linear / 分支**：[TEX-28](https://linear.app/texas-holdem/issue/TEX-28/testtex-28-implement-p0-integration-e2e-and-security-tests) · `test/TEX-28-implement-p0-integration-e2e-and-security-tests`
- **主责**：Trae Work
- **前置**：TEX-26、TEX-27。
- **要做什么**：验证完整多人流程、重连、乱序事件、多设备接管、私有信息隔离、无障碍与键盘主流程。
- **完成标准**：失败保留 Trace、截图、视频和 WS 摘要；未处理前端错误或未授权字段均使测试失败。
- **权威参考**：`docs/06-testing-strategy.md` §3.2～§3.4、§6、§7、§9。

## TEX-29：压测、稳定性与监控验证

- **Linear / 分支**：[TEX-29](https://linear.app/texas-holdem/issue/TEX-29/testtex-29-run-load-soak-and-monitoring-validation) · `test/TEX-29-run-load-soak-and-monitoring-validation`
- **主责**：Claude Code（2026-09-05 用户委派，覆盖旧分工 Trae Work）
- **前置**：TEX-22、TEX-28。
- **要做什么**：进行 100 Room/1,000 WS、突发命令、重连风暴、4 小时 Soak 和容量余量测试，并验证告警。
- **完成标准**：达到 P0 SLO 或输出可复现实测偏差；告警与报告绑定候选提交 SHA，且无私密数据。
- **权威参考**：`docs/06-testing-strategy.md` §10～§12。

## TEX-30：发布验收

- **Linear / 分支**：[TEX-30](https://linear.app/texas-holdem/issue/TEX-30/choretex-30-assemble-p0-release-evidence-and-acceptance) · `chore/TEX-30-assemble-p0-release-evidence-and-acceptance`
- **主责**：Codex（规划/验收）和用户（实机/发布决定）。
- **前置**：TEX-29。
- **要做什么**：整理同一候选提交的 CI、Simulation、E2E、Load/Soak、监控、真实设备与缺陷证据。
- **完成标准**：满足 P0 发布硬门槛；无未处置 P0/P1 缺陷；代码或部署配置变更后重跑受影响证据。
- **权威参考**：《德州扑克项目总规划》§9；`docs/06-testing-strategy.md` §9～§12。
