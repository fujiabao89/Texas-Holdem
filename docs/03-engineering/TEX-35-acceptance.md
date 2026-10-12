# TEX-35 跨手展示验收记录

2026-10-12，用户委派 Codex 修复 TEX-62 门禁发现的跨手结果丢失。范围为 AnimationQueue、展示订阅和牌桌 handId 准入；不改变扑克裁决、wire Schema 或行动 deadline。

普通同 Tournament/handId/sequence 的阶段 Snapshot 更新 canonical 并保留连续语义展示。Reduced Motion、降级、Hard Forward 与恢复屏障保留已接收的公开分池摘要，至少显示 1,000ms 后再切换手；旧手展示期间隐藏下一手动作与倒计时。隐藏页面不保留旧手阅读窗口或声音，恢复仍请求最新 Snapshot。缺失分池结果不由客户端推导。

针对性命令 `pnpm exec vitest run --project unit apps/web/src/animations apps/web/src/state/projection-store.test.ts --maxWorkers 1`：48 项通过。覆盖正常阶段快照、降级队列已经跨手、快进跨手、恢复静态摘要、Reduced Motion 一秒窗口、后台无 timer、重复事件及公开牌过滤；Web typecheck 与目标 ESLint 通过。真实浏览器验收由 TEX-62 的候选记录提供，尚未提前认定通过。

同步动画、状态、牌桌与 Web README，以及 02/05 权威规格。06 测试策略沿用 TEX-62 的正常/降级/恢复矩阵。01/03/04、安全与运维说明已检查，无需更新：没有改变服务端规则、持久化、消息结构、授权、日志、配置或发布流程。任务范围保持既有 TEX-35 边界。

RC 连续 DOM 观测进一步发现提交到 DOM 绘制的间隔会侵蚀一秒窗口。阅读计时现由 React 绘制回调开启，新增延迟绘制、跨手快进和陈旧通知回归；不改变权威行动时钟。
