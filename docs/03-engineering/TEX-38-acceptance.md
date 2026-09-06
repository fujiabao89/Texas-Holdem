# TEX-38 前端动画与音效优化验收

任务：[TEX-38](https://linear.app/texas-holdem/issue/TEX-38)。分支：`feat/TEX-38-optimize-animation-and-audio`，基线：`2f8df07d`。用户明确委派 Codex 实现；工程事实权威仍是 [05 §9.7/§10.3](../05-frontend-spec.md)。本记录保存验收证据，不另建产品规格。

## 审计与实施范围

现有发牌、公共牌和 Best Five 的可读节奏保留；审计缺口包括通用中央提示缺少 Seat/Pot 语义、缺少牌型及分池金额、减少动态时误静音、设置与牌桌偏好分离、后台补播、跨手发牌进度互相覆盖和 Showdown 动画实例复用。实现范围为 `apps/web` 的展示/音频/设置，以及专用 E2E 和对应文档。

独立 worktree 与端口 3138 避免修改/复用 TEX-29 的压测运行环境。game-server、引擎、通信 Schema、根依赖、CI、共享测试配置未改动。没有新素材来源、数据迁移或外部服务。

## 验证记录

- `pnpm exec vitest run --project unit apps/web --maxWorkers 1`：167 项通过，19 个文件（队列顺序、跨手、去重、后台、静态分池、快进结果停留、慢帧、音频故障/清理、偏好及既有前端回归）。
- `pnpm exec eslint apps/web tests/e2e/animation-audio`、`pnpm exec tsc --noEmit -p tsconfig.test.json`：通过。
- `pnpm --filter @texas-holdem/web build`：通过生产编译、TypeScript 与静态路由生成。
- 在独立 3138 端口启动该生产构建后，`$env:TEX_E2E_PORT='3138'; pnpm test:e2e --workers 1`：38 项通过，无重试；包含 11 项 TEX-38 专用回归及既有下注、Lobby、重连和错误门禁自测。3 个错误门禁负例以预期失败验证门禁，整套退出码为 0。
- Playwright CLI 对全部 11 个在用本地 MP3 经真实 Chromium 解码成功，时长约 0.170–1.324 秒；没有采用 Audio 替身。这只验证资源和编解码，不宣称设备扬声器听感或 iOS 自动播放验证完成。

### 浏览器与性能证据（2026-09-06）

- Chromium `151.0.7922.34`；360×800、390×844、1366×900 十人桌座位矩形两两不相交、无横向溢出、跟注提交最新 sequence。手机采用纵向滚动，截图人工复核不再遮挡本人手牌或公共牌。
- `output/playwright/TEX-38-{table-360,table-390,table-1366,settings,reduced-motion-outcome,cpu-6x}.png` 保留成功截图，不纳入 Git；失败诊断沿用已有 trace/video/错误摘要机制。
- 6x CPU 限速仅在入桌后启用，测量牌局动画与操作，不将 Next 开发冷启动混入样本。生产构建本机一轮 90 个真实 rAF 间隔：平均 35.56ms、P95 116.70ms、超过 34ms 的 15 帧，自动 reduced motion 实际触发；正确下注命令可提交，终帧完整。自动化点击至命令观测约 1298.7ms，含 Playwright 开销，不是原生输入延迟。数值随机器负载变化，不将 6x 等同实机型号。
- 首轮新增座位相交断言发现手机遮挡，修正后通过；完整回归发现遗漏的公共牌辅助状态文案，恢复单事件状态提示后通过。CPU 用例首轮在限速冷启动下超过等待窗口，已将非目标冷启动移出采样范围，未启用重试或降低事件断言。
- CLI 无夹具页面记录到既有 `/favicon.ico` 404；此资源不在动画/音频范围内，未捎带修改。专用及全量 E2E 的 console/pageerror/HTTP 5xx 门禁通过。

## 验收边界

日常浏览器模拟/CPU 限速不代替 [06 §9.1](../06-testing-strategy.md#91-release-设备与浏览器矩阵已裁决) 的 Android/iPhone 实机发布验收；本任务不发布生产，也不判定 TEX-29 的压力、稳定性或告警门禁完成。

文档同步检查覆盖 Web/动画/音频/设置/牌桌/样式/消息目录 README、05 前端契约、06 测试范围、项目任务入口和本验收记录。安全/运维说明：已检查，无需更新；本任务沿用既有服务端投影、身份与部署边界，无新增秘密、数据权限或基础设施行为。
