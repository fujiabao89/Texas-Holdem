# End-to-end tests

从玩家操作到服务端结果的完整流程测试（Playwright + axe-core）。

## 入口与配置

```bash
pnpm test:e2e                       # 根目录统一入口（启动 apps/web dev server）
pnpm test:e2e -- --grep "创建房间"   # 按标题过滤（业务用例落地后）
```

- 配置：[playwright.config.ts](./playwright.config.ts)；**禁用重试（含 CI）**——docs/06 §2.1 规定重试只可用于诊断，不得把"重试后通过"记为门禁通过（`tests/meta` 有防回归断言）。
- 端口默认 `3100`，可用 `TEX_E2E_PORT` / `TEX_E2E_BASE_URL` 覆盖；本地已运行的服务会被复用。
- 业务场景（创建房间、下注、重连等）按目录组织：[all-in/](./all-in)、[create-room/](./create-room)、[full-hand/](./full-hand)、[join-table/](./join-table)、[reconnect/](./reconnect)、[side-pot/](./side-pot)，由对应任务逐个落地；当前仅有 [smoke.spec.ts](./smoke.spec.ts)（页面加载 + axe 扫描）与 [observability.spec.ts](./observability.spec.ts)（门禁自测）。

## 失败产物保留策略（TEX-12）

| 产物 | 策略 |
| --- | --- |
| Trace / 视频 | `retain-on-failure`（仅失败保留，成功运行自动清理） |
| 截图 | `only-on-failure` |
| 浏览器 console error / pageerror | [fixtures/observability.ts](./fixtures/observability.ts) 收集：测试失败时输出 `[TEX-E2E-DIAGNOSTICS]` 摘要；**测试通过时执行 docs/06 §9 门禁——未处理的 console error / pageerror / HTTP 5xx 使测试失败** |
| 网络 / WebSocket 摘要 | 同上：仅 method + origin/path + status / 开闭状态 |
| CI 失败产物 | CI e2e job 失败时经 `actions/upload-artifact` 上传 `tests/e2e/.artifacts`（`.github/workflows/ci.yml`） |

脱敏约束：URL 剥离 query/hash（防 token 泄露）；不采集 headers、cookies 或请求/响应 body——私密牌面与密钥不会进入产物。本地全部产物写入 `.artifacts/`（已 gitignore）。

**门禁白名单**：预期内的浏览器错误（如已知第三方脚本报错）在用例内调用 `diagnostics.allow("子串或正则")` 豁免；门禁行为由 [observability.spec.ts](./observability.spec.ts) 自测守护。

## 可访问性扫描

[fixtures/a11y.ts](./fixtures/a11y.ts) 封装 `@axe-core/playwright`：`criticalViolations(page)` 或按 impact 阈值扫描。具体页面的 WCAG 2.2 AA 验收门槛由前端任务按 docs/05-frontend-spec.md §16 落地。
