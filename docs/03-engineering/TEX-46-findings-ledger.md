# TEX-46 / PR #56 Findings Ledger

审查范围：PR [#56](https://github.com/fujiabao89/Texas-Holdem/pull/56) 提交 `f03a7d48` 及 `main`（`5567e4fb`）对比。2026-09-17 逐项读取并核验 Codex、CodeRabbit、Greptile 的 review、inline comment 与 check；严重度按当前代码的实际用户影响与合并风险判定。9 条留言去重后为 6 个独立问题。

| ID | 来源 / 留言 | 有效性与精确失败场景 | 现有处理 / 测试 | 严重度 | 处置 |
| --- | --- | --- | --- | --- | --- |
| F-01 | Codex [`4035361130`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035361130) P2 + Greptile [`4035454112`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454112) P1（重复） | 有效。拥挤布局按物理座位号 `:has([data-seat="5"])`/`:has([data-seat="7"])` 触发，而槽位是按人数分配的（`poker-table-page.tsx` 的 `seatSlotsByOpponentCount[opponents.length]`），两套口径不一致。原注释断言"`data-seat` 只存在于已入座座位，故匹配 6 人以上桌"——该前提可证伪：`lobby-page.tsx` 提供 `CHANGE_SEAT` 与"选择座位"按钮，玩家可自选任意空座，座位数组按物理索引且允许空洞。失败场景：6 人坐在 {0,1,2,3,4,9} 时 5 号位空缺，6 人桌拿不到压缩布局（手机 76px 而非 62px 卡片），可能违反 docs/05 §7.5 的"各 Seat 矩形互不相交"；反之 3 人桌含 5 号位会被无谓压缩。 | 槽位分配本身按人数，正确；但几何分支按座位号，错误。夹具 `Array.from({length: playerCount}, (_, seat) => ...)` 恒为连续座位，掩盖了该分支。 | P2 | 已修正：根节点新增 `data-seat-density`（`compact` ≥6 人、`stacked` ≥8 人，由已入座人数推导），CSS 26 处选择器改为按人数字段触发；修正原注释中已被证伪的前提。对连续座位行为不变。 |
| F-02 | Codex [`4035361140`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035361140) P2 + Greptile [`4035454121`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454121) P2（重复） | 有效。桌面（≥640px）`--dock-reserve: 104px`，面板 `max-height:100%` + `overflow-y:auto`，内容盒仅 80px；而"标题 + 主操作行 + 延时按钮独占整行"实际需约 146px（padding 24 + heading 16 + gap 8 + 行 46 + gap 8 + 44），"使用延时"整行被裁切，展开金额面板后更甚。测试漏过：`single-viewport.spec.ts` 只把按钮矩形与视口比较，而 Playwright 的可见性判定不计祖先裁切。 | 面板裁切断言原本只存在于手机精确金额用例；桌面无等价断言。 | P2 | 已修正：桌面主操作改单行五列（`repeat(5, …)`，延时按钮不再独占整行），闭合态在 104px 内不再裁切；金额面板"替换而非堆叠"规则由手机提升为全宽度；新增"行动区不得内部滚动"断言覆盖全部视口与排布。 |
| F-03 | Greptile [`4035454562`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454562)、[`4035454570`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035454570) P2 ×2（重复） | 有效。`roomSnapshot`/`gameSnapshot` 均以 `Array.from({length: playerCount}, (_, seat) => ...)` 生成座位，物理座位恒为 `0..n-1`，2/3/6/10 人全部为连续排布；而布局分支读物理座位号，稀疏入座这一受支持场景零覆盖。 | 无既有稀疏座位夹具或断言。 | P2 | 已修正：夹具改为接受显式座位数组；新增"6 人稀疏座位"（`[0,2,4,6,8,9]`）排布，随既有三组断言在全视口矩阵中执行，新增 15 项用例。 |
| F-04 | CodeRabbit [`4035432530`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432530) Minor | 有效。`TEX-46-acceptance.md` 的"截至本记录…未推送、未创建 PR"是 2026-09-16 的历史快照，作为当时事实未失真；但第 56 行仍在**当前验收边界**中重复"未推送、未创建 PR、未发布。因此 CI 未在本分支运行过"，而 PR #56 已存在且 CI 已运行——该句现在是错的。同一文件第 9 行仍写"PR 目标分支必须设为 `feat/TEX-45-…`"，也与已 rebase 到 `main` 的事实不符。 | 文档无 PR 后的状态更新。 | P3 | 已修正：保留 2026-09-16 历史快照并标注时点，补充当前交付状态（PR #56、目标分支 `main`、CI 结果），第 56 行改为仅适用于记录时点。 |
| F-05 | CodeRabbit [`4035432538`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432538) Minor | 有效。`docs/06-testing-strategy.md` §2.1 明文要求"Flaky 用例等同失败，须修复或经负责人书面批准后带期限隔离"。验收记录只写"建议单独开任务处理"，既无负责人书面批准，也无期限，不满足该条。 | 无。 | P3 | 已修正（部分）：在验收记录中如实登记为**待批准**状态，写明缺书面批准与期限、不得记为已批准或已修复。**未**修改 `brand-experience.spec.ts`；取得负责人书面批准前不做隔离声明。 |
| F-06 | CodeRabbit [`4035432547`](https://github.com/fujiabao89/Texas-Holdem/pull/56#discussion_r4035432547) Minor | 有效。`single-viewport.spec.ts` 仅在按钮清单与 `toBeEnabled()` 中触及"全下至 1000"，从未点击二次确认、也未断言 `ALL_IN` 信封，即未执行"全下两步"；但 `docs/06-testing-strategy.md`、`tests/e2e/README.md` 与 `TEX-46-acceptance.md` 三处都称该套件"全下两步可完成"。同文件第 36 行与第 48 行自相矛盾（48 行正确指出该流程由 `tests/e2e/betting/table.spec.ts` 覆盖）。 | 无。 | P3 | 已修正：三处改为"全下按钮在行动区内可达"（这是本套件真实断言的内容），并注明两步全下与 `ALL_IN` 信封由 `tests/e2e/betting/table.spec.ts` 覆盖。 |

未发现 P0、安全、授权、数据完整性、并发或扑克规则问题。

## 与审查方的判断分歧

- **F-01 严重度**：Greptile 判 P1、Codex 判 P2。本台账判 **P2**——触发条件是稀疏入座（受支持但非默认），后果是座位卡片可能相交的展示缺陷，不涉及功能或数据错误。因其违反 docs/05 §7.5 的显式验收不变量，仍作为本 PR 阻断项修复。

## 未解决项

- **F-02 的展开态上限**：为容纳展开的桌面金额面板而提高 `--dock-reserve` 与既有"座位不相交"不变量**在矮/窄桌面视口不可兼得**——实测 1366×768 下 reserve 提到 152px 即使既有的 6/10 人桌用例座位相交，768×1024 下提到 240px 同样失败。最终处置为：矮窄视口保留 104px 由单行主操作适配；仅 `(min-width: 1200px) and (min-height: 900px)` 的宽高充裕视口才放大到 240px。**在这些矮桌面视口展开金额面板时，面板仍可能需要内部滚动**——该残留未在本 PR 内消除，需在后续任务中通过重新设计桌面金额面板行数解决。

## 修复后验证

- `pnpm typecheck`：通过（6 tasks successful）。
- `pnpm lint`：通过（4 tasks successful）。
- `pnpm test:unit`：**848 passed / 84 files**。
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts table-layout`：**86 passed**（修复前 71 passed；新增 15 项稀疏座位矩阵用例）。
- 迭代记录：reserve 提到 240px 时 6 项失败（1366×768 座位相交、页面滚动）；152px 时 3 项失败（1366×768 6/10 人桌座位相交）；最终方案 86 全通过。
