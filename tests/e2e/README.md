# End-to-end tests

从玩家操作到服务端结果的完整流程测试（Playwright + axe-core）。

## 入口与配置

```bash
pnpm test:e2e                       # 根目录统一入口（启动 apps/web dev server）
pnpm test:e2e -- --grep "创建房间"   # 按标题过滤（业务用例落地后）
```

- 配置：[playwright.config.ts](./playwright.config.ts)；**禁用重试（含 CI）**——docs/06 §2.1 规定重试只可用于诊断，不得把"重试后通过"记为门禁通过（`tests/meta` 有防回归断言）。
- 端口默认 `3100`，可用 `TEX_E2E_PORT` / `TEX_E2E_BASE_URL` 覆盖；本地已运行的服务会被复用。
- 业务场景（创建房间、下注、重连等）按目录组织：[all-in/](./all-in)、[betting/](./betting)、[create-room/](./create-room)、[full-hand/](./full-hand)、[join-table/](./join-table)、[reconnect/](./reconnect)、[side-pot/](./side-pot)。TEX-25 的 [betting/table.spec.ts](./betting/table.spec.ts) 通过 Playwright WebSocket mock 注入合法投影，覆盖键盘跟注、All-in 两步、房间关闭、被移出与 Session Replaced；TEX-26 的 [reconnect/tex-26.spec.ts](./reconnect/tex-26.spec.ts) 仅覆盖新增的接管对话框可访问性。两者均不依赖真实 game-server 或 sleep。

TEX-38 新增 [animation-audio/](./animation-audio/README.md) 的动画/音频/偏好与后台浏览器回归，使用协议投影夹具，独立于真实服务端套件。运行：`pnpm exec playwright test -c tests/e2e/playwright.config.ts animation-audio --workers=1`；并行开发时通过 `TEX_E2E_PORT=3138` 隔离端口。

## 真实链路套件（TEX-28：`real/`）

`pnpm test:e2e:real` 走完整真实链路：真实浏览器（独立 BrowserContext 身份隔离）→ 真实 apps/web → 真实本地 game-server → 真实 PostgreSQL（每次运行独立 `tex_e2e_real_<runId>` schema，结束清理）。与上面基于 Playwright WebSocket mock 的套件互补，**禁止**以 `route.fulfill`、伪造 Snapshot/Event 或直接改浏览器 store 替代被测业务链路（docs/06 §5）。

- 配置：[playwright.real.config.ts](./playwright.real.config.ts)（`retries: 0`、独立 `.artifacts-real` 产物目录、独立端口段）；`tests/meta` 有入口与配置自测。
- 依赖：环境变量 `TEX_TEST_DATABASE_URL`（缺失时启动即失败并提示设置指引——真实链路不允许静默降级或跳过）；服务由 Playwright `webServer` 托管启停；洗牌由 `TEX_TEST_RNG_SEED` 固定（main.ts 测试入口，生产默认安全随机）。
- 用例：[real/multiplayer-journey.spec.ts](./real/multiplayer-journey.spec.ts)（双人完整锦标赛+再来一局、三人全下摊牌/最佳五张/筹码守恒）、[real/security.spec.ts](./real/security.spec.ts)（WS 逐帧字段级隔离以 DB 私有事实为权威对照、token 不落 URL/持久存储、HTTP 错误信封脱敏）、[real/accessibility.spec.ts](./real/accessibility.spec.ts)（纯键盘主流程 + axe critical/serious 门禁 + Reduced Motion 业务结果不变）。
- 浏览器矩阵：chromium 全量；firefox/webkit 仅 `@key` 关键流程（配置内置 `grep`）。本断言门槛不宣称完整 WCAG 2.2 AA 通过（moderate/minor 与人工边界见 docs/06 §8）。
- 已知边界：Hand History 归档读取端点（TEX-36）未落地前，归档历史真实联调不宣称通过（见 docs/03-engineering/TEX-28-findings-ledger.md F-2）。

## 失败产物保留策略（TEX-12）

| 产物 | 策略 |
| --- | --- |
| Trace / 视频 | `retain-on-failure`（仅失败保留，成功运行自动清理） |
| 截图 | `only-on-failure` |
| 浏览器 console error / pageerror | [fixtures/observability.ts](./fixtures/observability.ts) 收集：测试失败时输出 `[TEX-E2E-DIAGNOSTICS]` 摘要；**测试通过时执行 docs/06 §9 门禁——未处理的 console error / pageerror / HTTP 5xx 使测试失败** |
| 网络 / WebSocket 摘要 | 同上：仅 method + origin/path + status / 开闭状态 |
| CI 失败产物 | CI e2e job 失败时经 `actions/upload-artifact` 上传 `tests/e2e/.artifacts`（`.github/workflows/ci.yml`） |

脱敏约束：URL 剥离 query/hash（防 token 泄露）；不采集 headers、cookies 或请求/响应 body——私密牌面与密钥不会进入产物。本地全部产物写入 `.artifacts/`（已 gitignore）。

**门禁白名单**：预期内的浏览器错误（如已知第三方脚本报错）在用例内调用 `diagnostics.allow("子串或正则")` 豁免；页面导航/关闭导致的 WS CONNECTING 中断（Firefox/Chromium/WebKit 各有文案）由 fixture **默认白名单**豁免；其余诊断仍强制门禁。门禁行为由 [observability.spec.ts](./observability.spec.ts) 自测守护。

## 可访问性扫描

[fixtures/a11y.ts](./fixtures/a11y.ts) 封装 `@axe-core/playwright`：`criticalViolations(page)` 或按 impact 阈值扫描。具体页面的 WCAG 2.2 AA 验收门槛由前端任务按 docs/05-frontend-spec.md §16 落地。
