# TEX-44 River & Raise 产品首页与前端视觉交互验收

任务：[TEX-44](https://linear.app/texas-holdem/issue/TEX-44)。分支：`feat/TEX-44-river-and-raise-design`；基线：`ebdbce16`。用户先确认 River & Raise 首页原型，再明确委派 Codex 按同一风格优化现有前端。产品与交互权威见 [05 前端规格 §6.1](../05-frontend-spec.md#61-home)，本记录只保存交付范围与验证证据。

审阅入口：[PR #45](https://github.com/fujiabao89/Texas-Holdem/pull/45)。

## 交付范围

- 产品首页接入真实 App Router，保留创建、加入与邀请码链接；开局选择使用原生 dialog。
- 暖白、深绿、陶橙配色贯穿创建/加入表单、Lobby 座位与邀请面板、牌桌、设置、赛果和历史抽屉。新增按钮悬停/按下、路由入场、首页装饰牌倾斜与展开。
- 共用既有系统/设备动态偏好，减少动态效果时保留静态内容和操作反馈。原生历史 dialog 限制背景交互，支持 Esc 及关闭后焦点返回。
- 表单仍通过原 HTTP 客户端提交；下注、全下确认、序列、重连、音效和结算继续由现有实现处理。新展示组件不参与服务端状态或动画事件队列。

实现位于独立工作树，避免改动原目录内尚未交接的工作。未更改 game-server、引擎、协议 Schema、数据库、依赖版本、CI 或部署配置；无新增外部素材和运行时服务。

## 验证记录（2026-09-10）

- `pnpm exec vitest run --project unit apps/web --maxWorkers 1`：19 个文件、168 项通过。
- `pnpm exec eslint apps/web tests/e2e/create-room tests/e2e/smoke.spec.ts tests/e2e/animation-audio/experience.spec.ts`：通过。
- 构建本地协议及引擎依赖后，`pnpm exec tsc --noEmit -p tsconfig.test.json`：通过；Web 类型检查通过。
- `pnpm --filter @texas-holdem/web build`：生产编译、TypeScript、全部路由生成通过。
- 独立 3191 端口运行生产构建后，设置 `TEX_E2E_BASE_URL=http://127.0.0.1:3191` 与 `TEX_E2E_PORT=3191`，执行 `pnpm exec playwright test -c tests/e2e/playwright.config.ts create-room smoke betting reconnect animation-audio --workers=1`：39 项全部通过，2.8 分钟，无重试。console/pageerror/HTTP 5xx 门禁通过。

浏览器覆盖首页开局键盘导航、创建提交与幂等键、邀请码仅预填、390/1366 像素品牌页面溢出与 axe serious/critical、系统和设备减少动态偏好、历史抽屉焦点、手机赛果、360/390/1366 像素十人桌、全下二次确认、最新序列下注、断线/接管、公开牌与音频降级。

新增测试调试中修正了手机筹码文字对比度、原生历史 dialog 的重复关闭按钮可访问名称，以及新增赛果夹具的合法终局状态。可访问性采样明确等待有限入场动画结束，避免将半透明过渡帧当成最终颜色。CPU 观察器在事件到达前订阅真实 DOM 变化，避免跨进程轮询漏掉短暂飞牌；只读取 DOM，不强制产品性能降级。CPU 测试保留 90 帧、6 倍限速、最新序列命令和终帧断言，整条测试时限为 60 秒以容纳采样和 trace/video 开销。

本机最终 Chromium 151.0.7922.34、390×844、6 倍 CPU 采样：90 帧平均 289.06ms、P95 1449.9ms、35 帧超过 34ms；自动化点击至命令观测约 7854ms，最终自动降级标志为 false。该轮包含 trace/video 与自动化开销，数据不支持“低端设备流畅”或原生输入延迟结论；测试仅确认受限环境下命令与终帧可达。前一轮默认 30 秒整条用例时限在采样期间超时，已保留记录，未将其作为通过。真实性能发布结论仍需设备矩阵验证。

成功品牌页面与手机赛果截图保存在 `tests/e2e/.artifacts/create-room-brand-experience-*/`，十人桌截图保存在 `output/playwright/TEX-38-table-*.png`；本次截图和日志另存本地验收目录，不提交生成产物。创建页、手机十人桌和赛果截图已人工复核。

## 预览与验收边界

本地生产预览使用 `pnpm --filter @texas-holdem/web start --port 3191 --hostname 127.0.0.1`。页面可直接查看；当前预览未配置真实 game-server，浏览器回归通过 Schema 校验的 HTTP/WS 夹具驱动牌局，不代表数据库或真实多人联调已完成。运行真实牌局仍按 Web README 的公开 API/WS 配置连接既有后端。

日常 Edge 人工复核和 Chromium 视口模拟不替代 [06 测试规格 §9](../06-testing-strategy.md) 的移动设备、浏览器和网络发布矩阵。该任务不发布生产，不启动 DeepSeek Harness 或 Greptile。

## 文档同步检查

已同步 Web、src/app、共享组件、Lobby、牌桌、设置、赛果、历史、消息目录 README，以及 E2E 相关目录、总规划、05 前端规格和项目/产品/工程索引。新验收链接随代码同一交付。

架构、协议、数据、安全、运维和 06 测试策略：已检查，无需更新；该任务没有新增公共接口、权限、秘密、数据结构或部署流程，新增测试沿用既有前端投影测试边界。扑克规则、边池和真实数据库测试未重跑，原因是对应实现未修改；现有前端队列、全下和重连回归已纳入验证。
