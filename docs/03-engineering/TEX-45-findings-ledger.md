# TEX-45 / PR #46 Findings Ledger

审查范围：PR #46 当前提交及 `main` 对比。2026-09-13 逐项读取并核验 Codex、CodeRabbit 和 Greptile 的 review、inline comment、issue comment 与 check；严重度按当前代码的实际用户影响和合并风险判定。

| ID | 来源 / 留言 | 有效性与精确失败场景 | 现有处理 / 测试 | 严重度 | 处置 |
| --- | --- | --- | --- | --- | --- |
| F-01 | Codex [`3998953984`](https://github.com/fujiabao89/Texas-Holdem/pull/46#discussion_r3998953984)：共享 axe 等待语义未同步到 `tests/e2e/README.md` | 有效。`scanAxeViolations` 新增等待 `.rr-route-enter` 动画结束的行为，但测试目录 README 仍只描述 impact 扫描入口。维护者无法从该目录文档得知扫描发生在最终视觉状态；这违反 `AGENTS.md` 对测试资产运行方式同步的完成条件。 | 验收记录说明了 CI 修复，但测试目录 README 和测试策略未记录该共享语义。 | P2 | 已修正：同步 `tests/e2e/README.md` 与 `docs/06-testing-strategy.md`，明确文档、标题和路由进入动画等待边界。 |
| F-02 | CodeRabbit [`3998962389`](https://github.com/fujiabao89/Texas-Holdem/pull/46#discussion_r3998962389)：不限时状态缺少独立实时区域 | 有效。合法的不限时牌局在手间无行动者时显示“等待其他玩家行动”；新行动机会到达后，`hasActor` 变为 `true` 且 `actionDeadline` 仍为 `null`，可见文本切换为“本桌不限行动时间”。原可见 `<p>` 非实时，常驻的连接状态区内容也不变化，因此读屏不会获知该状态变化。逐帧倒计时保持非实时是正确行为。 | 真实链路测试只断言页面存在任意 `role=status`，没有断言该消息由常驻独立区域播报。 | P2 | 已修正：保留可见时钟为非实时节点，增加常驻、独立且原子化的 polite status，仅在不限时行动状态出现/消失时改变内容；新增受控 WS E2E 回归。 |
| F-03 | CodeRabbit [`3998962391`](https://github.com/fujiabao89/Texas-Holdem/pull/46#discussion_r3998962391)：本人标记对比度不足 | 有效。本人座位背景为 `#f5f1df`，`.table-you` 的 `#778d54` 对比度约 3.24:1；9px 普通文本需要至少 4.5:1。现有 axe 牌桌扫描没有单独锁定该小标记，因此 CI 绿色不能否定问题。 | 本人昵称和筹码已有深色规则，但 `.table-you` 有独立浅色覆盖；没有针对该选择器的对比度断言。 | P2 | 已修正：只将 `.table-you` 前景色改为既有本人昵称色 `#254731`，对比度约 9.15:1；字号和布局不变。 |
| F-04 | CodeRabbit review summary：Docstring Coverage 7.69% | 非阻断、风格性工具警告。被统计的大部分函数是既有局部 React 渲染/纯展示函数；仓库 ESLint、TypeScript、测试策略和 CI 均没有 80% docstring 门槛，补齐注释不会修复产品或测试故障。 | 当前 `quality`、typecheck 和相关测试均覆盖实际门禁；CodeRabbit 自身将 12/13 标为 unsupported/skipped。 | P3 | 跳过：超出本 PR 的最小修复范围，不增加无验收价值的注释。 |
| F-05 | Greptile Review check | 无 finding。Greptile Review check 成功完成（9m16s），且未创建 review、inline comment 或 issue comment。 | 已核对 GitHub 三类评论接口与 check 结果。 | — | 无需变更；未再次触发 Greptile。 |

未发现 P0/P1、安全、授权、数据完整性、并发或扑克规则问题。F-01～F-03 是本 PR 的文档/无障碍验收缺口，修复保持在对应 README、测试语义、状态播报和颜色值范围内。

## 修复后验证

- `pnpm --filter @texas-holdem/web lint`：通过。
- `pnpm --filter @texas-holdem/web typecheck`：通过。
- `pnpm --filter @texas-holdem/web build`：通过。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/betting/table.spec.ts --workers=1`：16 项通过。
- `pnpm run test:e2e:real -- --grep '纯键盘主流程与关键页面 axe 扫描'`：Chromium、Firefox、WebKit 共 3 项通过。
- `git diff --check`：通过。
