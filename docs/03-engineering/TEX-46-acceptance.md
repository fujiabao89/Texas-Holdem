# TEX-46 单视口牌桌与按需行动区优化

用户于 2026-09-16 直接委派实现，要求完成后不推送、先给出报告。[Linear TEX-46](https://linear.app/texas-holdem/issue/TEX-46/tex-46-单视口牌桌与按需行动区优化)；分支 `feat/TEX-46-single-viewport-table-and-action-panel`，工作目录 `C:/Users/34026/Texas-Holdem-TEX-46`。**截至本记录，改动仅本地提交，未推送、未创建 PR、未发布。**（本记录与实现同处一个提交，故不在此记录该提交自身的哈希——它以分支 `feat/TEX-46-single-viewport-table-and-action-panel` 的 HEAD 为准。）

## 基线与依赖

基线为 `origin/feat/TEX-45-refine-in-game-table-and-cards`（`ce6653bf`），即 TEX-45 的牌桌视觉实现。TEX-46 的任务描述要求以 TEX-45 为基线，而 **TEX-45 的 PR [#46](https://github.com/fujiabao89/Texas-Holdem/pull/46) 当时仍未合并到 `main`**（其 Linear 状态已是 Done）。用户在开工前确认选择该分支作为基线，原因是 TEX-46 的验收项（不遮挡、单视口、响应式）必须落在 TEX-45 的真实视觉上才能验证。

**后果与本分支的处置**：本分支包含 TEX-45 的 4 个提交，因此 PR 目标分支必须设为 `feat/TEX-45-refine-in-game-table-and-cards`，否则 diff 会重复 TEX-45 的全部改动；TEX-45 合并后应改为以 `main` 为目标分支并重新核对差异。

## 范围与实现

仅修改 `apps/web` 的牌桌布局、行动区与其文档/测试，未改动扑克规则、服务端裁决、协议 Schema、下注金额计算、动画参数与音效资源。

- **单视口**：`.rr-site:has(.rr-table-page)` 把站点容器改为占满一个 `100dvh` 的 flex 列，`#page-content` 填充站点页头之外的剩余高度并取消页面滚动；两条规则用 `:has()` 限定，只在牌桌路由生效，其他路由布局不变。
- **牌桌自适应**：牌桌容器以 `container-type: size` 按 `--felt-ratio` 在剩余空间内取最大可用尺寸，并设 `min-height` 兜底，避免中央信息（街名、底池、公共牌）在极矮视口溢出到页面背景。
- **按需行动区**：牌桌容器固定预留 `--dock-reserve`，行动区只在该预留带内出现或消失。它仍只在服务端投影表明本人是当前行动者且 `viewer.legalActions` 非空时渲染——`table-state.ts` 的准入（连接、无 pending、未同步禁用）未放宽。
- **座位**：本人座位改为沿槽位底边对齐，含"本街投入"行的卡片不再溢出牌桌底边被行动区压住；6 人以上的手机与桌面牌桌压缩 Seat 卡片，8 人以上重排纵向分层，保证各 Seat 矩形互不相交。
- **手机行动区**：主按钮改三列；金额面板固定三行（快捷额 / 金额滑杆与 ± / 返回与提交），展开精确输入时以输入框替换快捷额行，面板高度不变；"返回操作"按钮仅在手机出现，用于从金额面板退回主操作行。
- **结果层**：本手结果摘要（`HandOutcomeSummary`）、终局排名与赛果入口改为浮于牌桌之上的覆盖层，不再挤压牌桌尺寸。

## 本地验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @texas-holdem/protocol build` | 通过（本工作目录首次构建 dist） |
| `pnpm typecheck` | 通过（6 tasks successful） |
| `pnpm lint` | 通过（4 tasks successful） |
| `pnpm --filter @texas-holdem/web build` | 通过 |
| `pnpm test:unit` | 75 files / 697 tests passed |
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout` | 69 passed |
| `pnpm test:e2e`（全量） | 113 passed + 1 失败（见"已知边界"） |

## 各目标视口验收证据

`tests/e2e/table-layout/single-viewport.spec.ts` 以 WS 投影夹具在真实浏览器中按 **5 视口 × 2/3/6/10 人桌** 矩阵断言：行动时无纵向/横向页面滚动；行动区、牌桌、公共牌与底池完整落在视口内；行动区不遮挡公共牌、底池与任何座位；各 Seat 卡片矩形互不相交；行动区随行动权出现与消失且不改变牌桌几何；手机金额面板的快捷额、Slider、±、精确输入、返回与提交全部在视口内可达，全下两步可完成。

本地证据截图（`fullPage`，页面本身不滚动故等于视口大小）生成于 `output/playwright/`，沿用 TEX-38 的既有约定、**不纳入版本控制**——`output/` 未被 `.gitignore` 忽略，因此运行后 `git status` 会显示 `?? output/`；该目录在本次工作前已存有 TEX-38 的 6 张截图，本次新增下列 6 张，共 12 个未跟踪文件：

- `TEX-46-360x800-10p.png`、`TEX-46-390x844-10p.png`、`TEX-46-768x1024-10p.png`、`TEX-46-1366x768-10p.png`、`TEX-46-1920x1080-10p.png`：十人桌行动中。
- `TEX-46-390x844-wager.png`：手机金额面板展开（三行布局）。

## 未运行项与已知边界

- **未推送、未创建 PR、未发布**（用户明确要求）。因此 CI 未在本分支运行过。
- **未运行真实链路套件**（`pnpm test:e2e:real`，需要 `TEX_TEST_DATABASE_URL` 与 PostgreSQL）与 **TEX-28 多人联调**；本任务的布局结论来自受控投影下的前端回归，不宣称真实服务端/数据库联调通过。
- **未做实机验收**：docs/06 §9.1 的 Android/iPhone 实机矩阵仍待发布前执行；本次为浏览器模拟视口。
- **DeepSeek Harness 审查**按项目约定由用户手动启动，本记录不代表该审查已通过。
- **既有并发 flakiness**：`tests/e2e/create-room/brand-experience.spec.ts` 在全量并发运行下会失败 1–4 个用例（`toHaveURL` 超时与 axe 超时），单独运行通过。已在 TEX-45 基线上复现同样失败，且在排除本任务新增测试后依然复现，故**与 TEX-46 无关**；建议单独开任务处理，不应记为本任务的回归。
- **单视口的取舍**：为让行动区出现/消失不引起布局跳动，行动区高度带被固定预留，非行动状态牌桌下方会留白；同时桌面 1366×768 下牌桌比 TEX-45 的滚动布局更小。这是单视口硬约束的代价，已由用户在本任务目标中确认。
