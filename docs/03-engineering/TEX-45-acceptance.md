# TEX-45 游戏内牌桌与扑克牌视觉优化

用户于 2026-09-11 直接委派 Codex 实现；明确保留动效、音效；初次本地验收后，用户追加授权提交、推送并创建 PR。[Linear TEX-45](https://linear.app/texas-holdem/issue/TEX-45)；分支 `feat/TEX-45-refine-in-game-table-and-cards`，独立工作目录 `C:/Users/34026/Texas-Holdem-TEX-45`。

## 基线与范围

从 `origin/main`（`ebdbce16`）创建分支，再快进到 TEX-44 已提交的 `1c2e0de0`，延续 River & Raise 产品风格。创建 PR 前对齐 TEX-44 后续已提交版本 `ca032e09`（仅首页字体样式变动），与本任务文件不冲突。TEX-44 的 PR #45 尚未合并，本任务以 `feat/TEX-44-river-and-raise-design` 为目标分支创建后续 PR；未修改原工作目录的部署文档、暂存内容或其他 Agent 的未交接工作。

仅修改牌桌展示、中文文案、局部 CSS 导入和对应文档。细纹深绿桌布、双层桌沿、独立底池金额、权威盲注摘要、暖白本人座位、牌角/牌背纹样，以及下注面板的信息层次得到调整。640–1000px 使用更高的椭圆，640–760px 进一步分开左右座位；手机保留纵向布局。不限时行动时不再显示与“轮到你行动”冲突的等待文案。CI 修复将辅助文字颜色调至 WCAG AA 对比度，并让 axe 扫描在路由进入动画完成后检查最终呈现状态；页面动效和音效实现未改变。

所有新 CSS 限制于 `.rr-table-page`。没有增加示例路由、客户端规则、依赖、服务端、协议或持久化变更。

## 动效和音效保留检查

- `src/animations/`、`src/audio/`、`public/sounds/` 和 `event-feedback.ts` 与基线无差异。
- `globals.css` 去掉新增的静态样式导入后，与基线相同；关键帧、时长、过渡与减少动态效果规则均保留。
- 牌桌文件经 TypeScript AST 比对（统一换行符），28 个函数保持原文，包括发牌、翻牌、Overlay、Showdown、几何测量和牌尺寸函数。9 个变动函数仅涉及展示结构、静态样式标记与时钟占位文案。
- CardFace/CardBack 继续参与原有动画组件；座位和底池移动后的飞行起终点仍由原有 DOM 实测机制获取，未另设轨迹或改变节奏。

## 本地验证

- `pnpm --filter @texas-holdem/protocol build`：通过。
- `pnpm --filter @texas-holdem/web lint`、`pnpm --filter @texas-holdem/web typecheck`：通过。
- `TEX_TEST_DATABASE_URL=postgres://tex_test:tex_test_pw@127.0.0.1:55432/tex_e2e pnpm run test:e2e:real -- --grep '纯键盘主流程与关键页面 axe 扫描'`：Chromium、Firefox、WebKit 共 3 项通过。
- `pnpm run test:e2e -- --workers=1`：44 项通过。12 worker 的额外本机全量复跑曾有 3 项既有交互竞争失败；单 worker 未复现，远端常规 `e2e` 检查也已通过。
- `pnpm exec vitest run --project unit apps/web --maxWorkers 1`：19 文件、168 项通过。
- `pnpm --filter @texas-holdem/web build`：生产构建、TypeScript 与全部路由生成通过。
- 使用 3195 端口的生产构建，设置 `TEX_E2E_BASE_URL=http://127.0.0.1:3195`、`TEX_E2E_PORT=3195`，执行 `pnpm exec playwright test -c tests/e2e/playwright.config.ts betting reconnect animation-audio --workers=1`：首轮 27 项通过。后续静态布局与不限时文案调整后，以 `--grep-invert '6x CPU'` 复核 26 项交互；CPU 采样不作为视觉布局门禁反复运行。
- Playwright CLI 通过经共享 Schema 校验的 WS 快照检查 2/3/6/10 人 × 360/390/640/700/760/768/1000/1024/1366px，共 36 组。覆盖五张公共牌、长昵称和五位数底池/本人筹码；文档不横向溢出，座位/Board/底池信息/行动者矩形无两两重叠，座位与牌数正确。
- 最终生产页面在 360/640/768/1366px 的 axe WCAG A/AA 检查没有 serious/critical 项；五张公共牌各自的矩形也无重叠。结果在 `output/playwright/accessibility-report.txt`。
- 截图人工检查桌面六人/十人局、手机与平板十人局。调试中发现并修复公共牌容器受绝对定位可用宽度影响而挤压、640px 座位重叠和底池/行动者与牌区间距不足；未把修复前的布局检查算作通过。

截图与本地 CLI 检查脚本位于 `output/playwright/`，生成产物不纳入代码交付。主要画面为 `TEX-45-6p-1366.png`、`TEX-45-6p-390.png`、`TEX-45-10p-640.png`、`TEX-45-10p-768.png`。`layout-report.txt` 保留 36 组检查结果。

## 验收边界与交付状态

这是本地生产构建上的 UI/受控协议投影验证，未启动真实 game-server/PostgreSQL 多人链路。音频回归采用现有故障注入，不能替代真实设备听感与自动播放策略验收；视口模拟不替代移动实机验证。首页手工浏览出现原有 `/favicon.ico` 404，属于任务外资源问题；没有改动首页或顺带增加图标。

用户追加授权后，将本任务代码和文档共同提交、推送并创建 PR。Linear 保持 In Review，等待审查；本 PR 依赖 TEX-44 的 PR #45，合入 main 前需在其合并后重新核对目标分支与差异。未合并、未发布，也未触发 DeepSeek Harness 或 Greptile。

## 文档同步检查

已更新 Web、牌桌、下注、App 和消息目录 README、05 前端权威规格、项目任务索引及工程验收索引。

总规划、产品范围/路线图、协议、架构、数据、安全、运维与 06 测试策略：**已检查，无需更新**，原因是本任务仅调整既有游戏页面展示，未新增功能、接口、规则、权限、数据或运行流程。测试说明已在本验收记录列明，沿用既有测试入口；没有新建永久测试套件。所有新增文档链接随代码在同一 PR 交付。
