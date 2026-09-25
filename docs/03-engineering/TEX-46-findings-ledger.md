# TEX-46 / PR #56 Findings Ledger

审查范围：PR [#56](https://github.com/fujiabao89/Texas-Holdem/pull/56) 提交 `f03a7d48` 及 `main`（`5567e4fb`）对比。2026-09-17 逐项读取并核验 Codex、CodeRabbit、Greptile 的 review、inline comment 与 check；严重度按当前代码的实际用户影响与合并风险判定。9 条留言去重后为 6 个独立问题。

| ID | 来源 / 留言 | 有效性与精确失败场景 | 现有处理 / 测试 | 严重度 | 处置 |
| --- | --- | --- | --- | --- | --- |
| F-01 | Codex [`4035361130`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035361130) P2 + Greptile [`4035454112`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454112) P1（重复） | 有效。拥挤布局按物理座位号 `:has([data-seat="5"])`/`:has([data-seat="7"])` 触发，而槽位是按人数分配的（`poker-table-page.tsx` 的 `seatSlotsByOpponentCount[opponents.length]`），两套口径不一致。原注释断言"`data-seat` 只存在于已入座座位，故匹配 6 人以上桌"——该前提可证伪：`lobby-page.tsx` 提供 `CHANGE_SEAT` 与"选择座位"按钮，玩家可自选任意空座，座位数组按物理索引且允许空洞。失败场景：6 人坐在 {0,1,2,3,4,9} 时 5 号位空缺，6 人桌拿不到压缩布局（手机 76px 而非 62px 卡片），可能违反 docs/05 §7.5 的"各 Seat 矩形互不相交"；反之 3 人桌含 5 号位会被无谓压缩。 | 槽位分配本身按人数，正确；但几何分支按座位号，错误。夹具 `Array.from({length: playerCount}, (_, seat) => ...)` 恒为连续座位，掩盖了该分支。 | P2 | 已修正：根节点新增由已入座人数推导的 `data-seat-density`。合并 TEX-47 的稳定顺时针槽位映射后，3 人起即会占用相邻侧翼槽位，因此 3 人以上统一启用 `stacked` 压缩分层；360×800 下把 4/6 号下层槽位调整到 87%，使其与 3/7 号中层间距约 94px，大于实测 89px 卡高。连续、稀疏与 2/3/6/10 人矩阵均覆盖。 |
| F-02 | Codex [`4035361140`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035361140) P2 + Greptile [`4035454121`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454121) P2（重复） | 有效。桌面（≥640px）`--dock-reserve: 104px`，面板 `max-height:100%` + `overflow-y:auto`，内容盒仅 80px；而"标题 + 主操作行 + 延时按钮独占整行"实际需约 146px（padding 24 + heading 16 + gap 8 + 行 46 + gap 8 + 44），"使用延时"整行被裁切，展开金额面板后更甚。测试漏过：`single-viewport.spec.ts` 只把按钮矩形与视口比较，而 Playwright 的可见性判定不计祖先裁切。 | 面板裁切断言原本只存在于手机精确金额用例；桌面无等价断言。 | P2 | 已修正：桌面主操作改单行五列（`repeat(5, …)`，延时按钮不再独占整行），闭合态在 104px 内不再裁切；金额编辑器统一为三行，展开时替换主操作行，并把全下入口保留在编辑器第三行，兼容普通加注、全下二次确认及两者之间切换。新增面板 `scrollHeight <= clientHeight + 1` 断言；768×1024 与 1920×1080 展开态无内部滚动，手机精确金额态同样无内部滚动。 |
| F-03 | Greptile [`4035454562`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454562)、[`4035454570`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454570) P2 ×2（重复） | 有效。`roomSnapshot`/`gameSnapshot` 均以 `Array.from({length: playerCount}, (_, seat) => ...)` 生成座位，物理座位恒为 `0..n-1`，2/3/6/10 人全部为连续排布；而布局分支读物理座位号，稀疏入座这一受支持场景零覆盖。 | 无既有稀疏座位夹具或断言。 | P2 | 已修正：夹具改为接受显式座位数组；新增"6 人稀疏座位"（`[0,2,4,6,8,9]`）排布，随既有三组断言在全视口矩阵中执行，新增 15 项用例。 |
| F-04 | CodeRabbit [`4035432530`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432530) Minor | 有效。`TEX-46-acceptance.md` 的"截至本记录…未推送、未创建 PR"是 2026-09-16 的历史快照，作为当时事实未失真；但第 56 行仍在**当前验收边界**中重复"未推送、未创建 PR、未发布。因此 CI 未在本分支运行过"，而 PR #56 已存在且 CI 已运行——该句现在是错的。同一文件第 9 行仍写"PR 目标分支必须设为 `feat/TEX-45-…`"，也与已 rebase 到 `main` 的事实不符。 | 文档无 PR 后的状态更新。 | P3 | 已修正：保留 2026-09-16 历史快照并标注时点，补充当前交付状态（PR #56、目标分支 `main`、CI 结果），第 56 行改为仅适用于记录时点。 |
| F-05 | CodeRabbit [`4035432538`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432538) Minor | 有效。`docs/06-testing-strategy.md` §2.1 明文要求"Flaky 用例等同失败，须修复或经负责人书面批准后带期限隔离"。验收记录只写"建议单独开任务处理"，既无负责人书面批准，也无期限，不满足该条。 | 无。 | P3 | 已修正（部分）：在验收记录中如实登记为**待批准**状态，写明缺书面批准与期限、不得记为已批准或已修复。**未**修改 `brand-experience.spec.ts`；取得负责人书面批准前不做隔离声明。 |
| F-06 | CodeRabbit [`4035432547`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432547) Minor | 有效。`single-viewport.spec.ts` 仅在按钮清单与 `toBeEnabled()` 中触及"全下至 1000"，从未点击二次确认、也未断言 `ALL_IN` 信封，即未执行"全下两步"；但 `docs/06-testing-strategy.md`、`tests/e2e/README.md` 与 `TEX-46-acceptance.md` 三处都称该套件"全下两步可完成"。同文件第 36 行与第 48 行自相矛盾（48 行正确指出该流程由 `tests/e2e/betting/table.spec.ts` 覆盖）。 | 无。 | P3 | 已修正：三处改为"全下按钮在行动区内可达"（这是本套件真实断言的内容），并注明两步全下与 `ALL_IN` 信封由 `tests/e2e/betting/table.spec.ts` 覆盖。 |
| F-07 | Codex [`4056408211`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4056408211) P1 + CodeRabbit 顶层审查 [`5748392152`](https://github.com/fujiabao89/Texas-Holdem/pull/56#issuecomment-5748392152) P1（重复） | 有效。金额编辑器在所有视口隐藏主操作行，但“返回操作”仅在手机显示；768×1024 与更宽视口进入 Bet/Raise 后无法取消草稿并重新选择 Fold/Call/Time Bank。 | 既有返回流程 E2E 仅覆盖 390×844。 | P1 | 已修正：所有视口显示返回按钮，并把精确金额按钮固定到第三行第二列，避免与返回按钮重叠；768×1024、1920×1080 展开态回归同时断言可返回并恢复主操作行。 |

未发现 P0、安全、授权、数据完整性、并发或扑克规则问题。

## 与审查方的判断分歧

- **F-01 严重度**：Greptile 判 P1、Codex 判 P2。本台账判 **P2**——触发条件是稀疏入座（受支持但非默认），后果是座位卡片可能相交的展示缺陷，不涉及功能或数据错误。因其违反 docs/05 §7.5 的显式验收不变量，仍作为本 PR 阻断项修复。

## 后续解决项

- **F-02 的矮桌面上限（后续已解决）**：原三行展开编辑器需约 203px，1366×768 无法在不使 Seat 相交的前提下扩大预留带。后续桌面改为两行并列编辑器与 124px 固定预留带，手机仍为三行；1366×768、1467×897、768×1024、1920×1080 的展开及精确输入态均验证面板与全部控件在预留带内、无页面或面板滚动，1366×768 的座位不相交矩阵亦通过。

## 合并 main 后的 CI 修复

远端分支 `b964f577` 合入 `main`（含 TEX-58/PR #54，wire v5）后 CI `e2e` 失败。根因：TEX-58 为 `GameSnapshot` 新增必填字段 `showdownDisplayUntil`（`handPhase !== "SHOWDOWN_DISPLAY"` 时必须为 `null`），TEX-46 的投影夹具未同步，投影校验失败导致牌桌停在加载态、行动区永不渲染。与先前"同步 wire v4 座位盲注字段"属同类问题。

已修正：`tests/e2e/table-layout/single-viewport.spec.ts` 的 `gameSnapshot` 补 `showdownDisplayUntil: null`，table-layout 套件恢复 86 passed。

### 合并 TEX-47 后的移动端徽标回归

2026-09-20 的 CI `e2e`（run `35451002198`）有 **136 passed / 2 failed**；失败均为 `stable-seats.spec.ts` 的 10 人桌手机用例（360×800、390×844）。实测 D/SB/BB 徽标与本 Seat 的 40px 底牌盒相交 1px。根因是紧凑 Seat 继承底牌容器的 `-mb-1`，而 TEX-47 新增的昵称行徽标恰好进入该负边距区域。

已修正：仅在手机 `data-seat-density` 布局中把底牌盒视觉上移 1px；CSS transform 不参与布局计算，因此不会增加 Seat 总高度，也不会重新触发相邻槽位相交。CI 同配置（`CI=1`、2 workers）的完整 mock Playwright 套件本地 **138 passed**；定向的 10 人桌徽标、360×800 六人桌/十人桌座位互斥矩阵 **18 passed**。

## 修复后验证

2026-09-19 合并 `main`（含 TEX-47 稳定座位映射）后的当前证据：

- `pnpm lint`：通过（4 tasks successful；缓存输出保留一条 TEX-47 工作树既有 unused-var warning，无 error）。
- `pnpm typecheck`：通过（6 tasks successful）。
- `pnpm exec vitest run --project unit apps/web/src/features/poker-table --maxWorkers 1`：**18 passed / 3 files**。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts betting/table.spec.ts --workers=1`：**16 passed**。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout --workers=1`：**88 passed**，包括 360×800 的 3/6/10 人稳定槽位不相交、手机精确金额无内部滚动，以及 768×1024 / 1920×1080 展开金额面板无内部滚动。
- `CI=1 pnpm run test:e2e`：**138 passed**（2 workers），覆盖上述徽标回归与完整 mock 浏览器门禁。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/table-layout/single-viewport.spec.ts --grep '精确金额可返回|展开金额面板不产生内部滚动' --workers=1`：**3 passed**，覆盖手机既有返回路径及 768×1024、1920×1080 非手机展开态返回主操作行。

下列记录为本轮合并前的历史验证证据：

- `pnpm typecheck`：通过（6 tasks successful）。
- `pnpm lint`：通过（4 tasks successful）。
- `pnpm test:unit`：**848 passed / 84 files**。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout`：**86 passed**（修复前 71 passed；新增 15 项稀疏座位矩阵用例）。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts betting/table.spec.ts`：**16 passed**。
- `pnpm test:e2e`（全量）：**129 passed / 2 failed**，失败全部落在 `create-room/brand-experience.spec.ts` 的既有并发 flaky（两次运行失败集合互不相同），与本 PR 无关。
- `pnpm test:unit`：**848 passed / 84 files**。
- 迭代记录：reserve 提到 240px 时 6 项失败（1366×768 座位相交、页面滚动）；152px 时 3 项失败（1366×768 6/10 人桌座位相交）；合并 TEX-47 后按稳定槽位重算 3 人以上的压缩分层，并把手机下层槽位调整到 87%。
