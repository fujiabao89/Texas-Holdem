# TEX-46 单视口牌桌与按需行动区优化

用户于 2026-09-16 直接委派实现，要求完成后不推送、先给出报告。[Linear TEX-46](https://linear.app/texas-holdem/issue/TEX-46/tex-46-单视口牌桌与按需行动区优化)；分支 `feat/TEX-46-single-viewport-table-and-action-panel`，工作目录 `C:/Users/34026/Texas-Holdem-TEX-46`。**截至 2026-09-16 本记录成文时，改动仅本地提交，未推送、未创建 PR、未发布；以下为该时点的快照。**（本记录与实现同处一个提交，故不在此记录该提交自身的哈希——它以分支 `feat/TEX-46-single-viewport-table-and-action-panel` 的 HEAD 为准。）

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
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout` | 71 passed |
| `pnpm test:e2e`（全量） | 112 passed + 4 失败，全部为 `create-room/brand-experience.spec.ts` 的既有并发 flaky（见"已知边界"） |

## 各目标视口验收证据

`tests/e2e/table-layout/single-viewport.spec.ts` 以 WS 投影夹具在真实浏览器中按 **5 视口 × 2/3/6/10 人桌 + 6 人稀疏座位（0,2,4,6,8,9）** 矩阵断言：行动时无纵向/横向页面滚动；行动区、牌桌、公共牌与底池完整落在视口内；行动区不遮挡公共牌、底池与任何座位；各 Seat 卡片矩形互不相交；行动区随行动权出现与消失且不改变牌桌几何；手机金额面板的快捷额、Slider、±、精确输入、返回与提交全部在视口内可达，全下按钮在行动区内可达（两步全下与 `ALL_IN` 信封由 `tests/e2e/betting/table.spec.ts` 覆盖）。

本地证据截图（`fullPage`，页面本身不滚动故等于视口大小）生成于 `output/playwright/`，沿用 TEX-38 的既有约定、不纳入版本控制。TEX-46 已在 `.gitignore` 补上根目录规则 `/output/`，该目录因此不再出现在 `git status`，截图仍保留在本地。该目录在本次工作前已存有 TEX-38 的 6 张截图，本次新增下列 6 张：

- `TEX-46-360x800-10p.png`、`TEX-46-390x844-10p.png`、`TEX-46-768x1024-10p.png`、`TEX-46-1366x768-10p.png`、`TEX-46-1920x1080-10p.png`：十人桌行动中。
- `TEX-46-390x844-wager.png`：手机金额面板展开（三行布局）。

## 首轮验收意见的处理（2026-09-16）

首轮验收结论为"暂不通过"，提出两条 P2 与两条交付一致性问题，均已修正：

- **P2-1 精确金额模式产生面板内部滚动**（`poker-table.css`）：原实现只隐藏快捷额行，却把整个"返回操作 / 精确输入开关 / 金额输出 / 精确输入框"容器移到第一行，输入框并未一对一替换快捷额行，实测 390×844 下面板 `clientHeight` 174 / `scrollHeight` 244，Slider 与提交按钮被裁切。修正为：精确输入框成为金额面板的**独立网格项**（`.table-exact-amount`），独占快捷额所在的第一行，快捷额行在展开时隐藏；金额输出移入第二行滑杆行右侧；校验错误文案改为输入框旁的同行小字（`<label>` 内 `<span role="alert">`），不再新增行。手机金额面板因此严格保持三行。
- **P2-2 回归测试没有进入精确金额状态**（`single-viewport.spec.ts`）：原断言只比较控件底边与 `window.innerHeight`，未进入精确输入、也未检查面板底边或 `scrollHeight`，缺陷可漏过。新增两个视口（360×800、390×844）的用例：打开精确输入、填写合法金额，断言 `panel.scrollHeight <= panel.clientHeight + 1`、页面无滚动、面板内每个可见控件矩形完整位于面板矩形内且在视口内；另增用例验证可"返回操作"回到主操作行，并验证精确草稿在提交时被采用（`RAISE raiseTo: 42`）。全下两步与命令内容仍由 `tests/e2e/betting/table.spec.ts` 覆盖。
- **验收记录哈希**：不再记录与文档同处一个提交的自身哈希，改以分支 HEAD 为准。
- **工作区卫生**：测试文件的 Prettier 归一化已提交；`output/` 已由 `.gitignore` 的 `/output/` 规则忽略；`apps/web/next-env.d.ts` 被 `next dev` 自动改写的内容已恢复，未进入提交。

修正后的验证：`pnpm typecheck` / `pnpm lint` 通过，`pnpm test:unit` 697 passed，`pnpm exec playwright test … table-layout` 71 passed。

## 合并 main 后的 CI 修复（2026-09-17）

远端分支合入 `main`（含 TEX-58/PR #54，wire v5）后 CI `e2e` 失败。根因：TEX-58 为 `GameSnapshot` 新增必填字段 `showdownDisplayUntil`（`handPhase !== "SHOWDOWN_DISPLAY"` 时必须为 `null`），本套件的投影夹具未同步，投影校验失败后牌桌停在加载态、行动区永不渲染。与先前"同步 wire v4 座位盲注字段"属同类问题。

已在 `tests/e2e/table-layout/single-viewport.spec.ts` 的 `gameSnapshot` 补 `showdownDisplayUntil: null`；table-layout 套件恢复全绿。

## 合并 TEX-47 后的移动端徽标 CI 修复（2026-09-20）

CI run `35451002198` 的 mock `e2e` 为 136 passed / 2 failed；两项失败均是 `stable-seats.spec.ts` 在 360×800 与 390×844 十人桌中发现 D/SB/BB 徽标与本 Seat 底牌盒相交 1px。紧凑布局的底牌容器继承 `-mb-1`，TEX-47 新增徽标后暴露了该像素级边界。

修复只在手机 `data-seat-density` 布局把底牌盒视觉上移 1px，不改变 Seat 的布局高度。定向徽标与座位互斥矩阵 18/18 通过；按 CI 配置执行完整 `CI=1 pnpm run test:e2e` 为 **138/138 通过**。目录 README 与前端/测试权威规格已检查，无需更新：既有契约已经要求徽标不得遮挡底牌且 Seat 矩形不得相交，本次只恢复该既定行为，没有新增页面流程、接口或运行方式。

## PR #56 审查意见处置

Codex / CodeRabbit / Greptile 的 9 条意见逐项核验与处置见 [TEX-46-findings-ledger.md](./TEX-46-findings-ledger.md)。

## 用户批准的整体布局调整（2026-09-24）

本节为 2026-09-23 用户追加、次日完成收尾的牌桌布局范围；上文为各历史阶段记录。开始前已按要求单独提交上一轮中央留白调整：`1b176956 feat(TEX-46): separate board and viewer hand zones`，未推送。本轮整体布局保留为未提交改动，等待用户确认视觉效果。

- 对手信息卡与底牌约缩小三分之一，本人手牌只轻微缩小且明显大于对手；座位跨坐桌沿，为公共牌与底池释放空间。
- 本街投入拆为独立桌面筹码标记，带玩家名称的辅助标签；下注出现/清零不再改变 Seat 高度。持久玩家状态与临时动作反馈分开显示。
- 完整参赛名单选择 2/6/10 人模板，连续与稀疏物理座位均按相对本人顺时针顺序排列。弃牌、全下、淘汰与撤回不筛除名单，因此不会换位；实际名单变化才允许重新分配。该项按用户批准取代 TEX-47 的统一偏移公式，权威说明见 [前端规格 §7.2](../05-frontend-spec.md)。
- 手机短横屏使用左侧牌桌、右侧完整操作列，竖屏保留可操作回退与非阻断横屏提示；不强制锁定方向。中央留白、边池明细和玻璃行动区仍保留。
- 没有修改规则引擎、通信 Schema、服务端裁决、命令或动画时序；未触发外部审查、提交牌局操作或推送当前改动。

文档同步：已更新 `apps/web`、牌桌、路由样式、文案及 E2E 目录 README，前端/测试权威规格和本任务验收记录；架构、协议、安全、部署及运维文档**已检查，无需更新**，原因是本轮仅改变前端布局与对应测试，不新增接口、权限、运行配置或产品范围。更广路线图也无需调整，本次仍属 TEX-46 的用户批准追加布局验收。

本地验证（复用 TEX-46 的 3000 端口服务）：

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，6 个工作区任务及测试 TypeScript 检查 |
| `pnpm exec eslint`（本轮修改的 TS/TSX 与 E2E 文件） | 通过 |
| `pnpm exec vitest run --project unit apps/web/src/features/poker-table --maxWorkers 1` | 3 files / 18 tests passed |
| `TEX_E2E_BASE_URL=http://127.0.0.1:3000 TEX_E2E_PORT=3000 pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout seats --workers=2 --reporter=json` | 168 passed，0 failed / 0 flaky |
| `git diff --check` | 通过 |

浏览器结果与截图保留在未纳入版本控制的 `output/playwright/`：`TEX-46-full-layout-results.json`、`TEX-46-1366x768-10p.png`、`TEX-46-360x800-10p-rail.png`、`TEX-46-800x360-10p-rail.png` 等。验证期间没有修改页面缩放、提交真实牌局动作或改变游戏规则。

验证边界：浏览器视口覆盖 360×800、390×844、768×1024、1366×768、1920×1080、844×390、800×360，并包含 640×800/1467×897 边界用例；当前真实双人房间已做只读视觉检查。没有运行全量跨模块 E2E、真实服务端/数据库联调套件、生产构建或 Android/iPhone 实机旋转验收，不将本轮结果等同于发布验收。

## 小尺寸牌面重叠修复（2026-09-25）

上一轮整体布局已按用户要求提交为 `0f1bd117 feat(TEX-46): add compact rail-based table layouts`；本节是之后追加的牌面缺陷修复，尚未提交或推送。

根因：小牌沿用两端牌角与中央 A 花色/J/Q/K 图案，字号却是固定像素或屏幕断点字号，没有随已经缩小的牌框变化。修复将对手公开底牌、摊牌候选/最佳五张和本手结算的小牌改为单组上下分开的牌值与花色。浏览器复核时也确认短横屏公共牌存在同类重叠，因此公共牌与本人手牌保留标准牌点排版，但各字形统一按自己的牌宽缩放；双字符 `10` 牌角单独收紧。

本轮未改变牌框大小、座位/操作区布局、牌点坐标、牌局规则、公开权限、服务端投影、牌的可访问名称或动画时序。新增真实 Chromium 回归覆盖 1366×768、360×800、844×390，在公共牌、本人手牌、摊牌候选/最佳五张、结算与对手亮牌中测量字形边界，检查无相交/无牌框裁切。现有连续摊牌及减少动态效果的结果展示回归同时执行。

验证命令：

- `pnpm exec eslint apps/web/src/features/poker-table/poker-table-page.tsx tests/e2e/animation-audio/experience.spec.ts`
- `pnpm --filter @texas-holdem/web typecheck`
- `pnpm exec tsc --noEmit -p tsconfig.test.json`
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts --grep '小牌|公共牌依次|减少动态效果仍保留' --workers=1`（测试服务使用 3100 端口，`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3100`、`NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3100/api/v1/ws`，仅本次进程环境）
- `git diff --check`

以上检查全部通过；定向 E2E 为 **5 passed，0 failed，0 retries**。截图沿用 `output/playwright/TEX-38-compact-*.png`；最佳五张完整排版截图保留为 E2E 附件。此类截图完成 CSS 动画以观察终态，不作为动画时序证据。

文档同步：已更新牌桌与动画 E2E 目录 README、前端权威规格及本记录。任务范围/路线图、其他权威规格、安全、部署与运维说明**已检查，无需更新**，因为本轮仅修复既有牌面展示，不新增接口、权限、流程或运行配置。验证限于 Chromium 模拟视口，未执行全量 E2E、真实服务端联调或手机实机验收。

## PR #56 Dependency Review 处置（2026-09-25）

新推送触发的 Dependency Review 因高危 `GHSA-c2qf-rxjj-qqgw` 失败：`react-rewrite-cli@0.1.1` 带入 `semver@5.6.0`；GitHub Advisory 标明受影响版本为低于 5.7.2。该开发依赖在仓库无引用，因此从 `apps/web/package.json` 与锁文件移除，而不是只在锁文件强制覆盖其传递依赖。提交 `3daefcfd` 推送后，PR 检查运行 `36107802522` 的 Dependency Review 已通过；本地无须重跑业务测试。

## 未运行项与已知边界

- **交付状态（2026-09-17 更新）**：已推送并创建 PR [#56](https://github.com/fujiabao89/Texas-Holdem/pull/56)，目标分支 `main`（分支已 rebase 到 `main@5567e4fb`）。CI 已在该分支运行，`quality`、`e2e`、`e2e-real`、`perf-smoke`、CodeQL、`branch-and-pr-policy`、`repository-hygiene`、`workflow-lint` 全部通过。上一条「未推送、未创建 PR、CI 未运行过」仅适用于 2026-09-16 记录成文时点。
- **未运行真实链路套件**（`pnpm test:e2e:real`，需要 `TEX_TEST_DATABASE_URL` 与 PostgreSQL）与 **TEX-28 多人联调**；本任务的布局结论来自受控投影下的前端回归，不宣称真实服务端/数据库联调通过。
- **未做实机验收**：docs/06 §9.1 的 Android/iPhone 实机矩阵仍待发布前执行；本次为浏览器模拟视口。
- **DeepSeek Harness 审查**按项目约定由用户手动启动，本记录不代表该审查已通过。
- **既有并发 flakiness**：`tests/e2e/create-room/brand-experience.spec.ts` 在全量并发运行下会失败 1–4 个用例（`toHaveURL` 超时与 axe 超时），单独运行通过。已在 TEX-45 基线上复现同样失败，且在排除本任务新增测试后依然复现，故**与 TEX-46 无关**，不应记为本任务的回归。**处置状态：待批准。** docs/06 §2.1 要求 Flaky 用例修复、或经负责人书面批准后带期限隔离；本任务未取得该书面批准，也未设定隔离期限，故**不声明为已隔离或已修复**，需由负责人批准并给出期限后另行处置。
- **单视口的取舍**：为让行动区出现/消失不引起布局跳动，行动区高度带被固定预留，非行动状态牌桌下方会留白；同时桌面 1366×768 下牌桌比 TEX-45 的滚动布局更小。这是单视口硬约束的代价，已由用户在本任务目标中确认。
