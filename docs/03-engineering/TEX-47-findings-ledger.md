# TEX-47 审查 Findings Ledger

审查时间：2026-09-17（人工验收 2026-09-16 + 机器人审查 2026-09-17）
范围：Draft PR [#55](https://github.com/fujiabao89/Texas-Holdem/pull/55) 的当前分支 `feat/TEX-47-stable-seat-order-and-dealer-blind-markers`，逐项复核人工验收、Codex、CodeRabbit、Greptile、Copilot 与 Qodo 留言；不重新触发任何审查服务。

严重性遵循 [05 前端规格](../05-frontend-spec.md) §16：P1 为阻断主流程或违反已裁决交互；P2 为应在本 PR 修复的可靠性/交互/证据缺陷；P3 为不改变运行时代码正确性的测试或文档增强；本轮无 P0。

| ID | 来源 / 留言 | 当前代码与失败场景 | 已有防线 / 测试 | 严重性 | 处置 |
| --- | --- | --- | --- | --- | --- |
| F-01 | 人工验收（2026-09-16）：徽标 `aria-label` 未进入可访问性树 | 确认。裸 `span[aria-label]` 不参与可访问名称计算，Chromium AX 快照只有 `text: D/SB/BB`；原 E2E 只断言属性存在，无法发现。 | 牌面已使用 `role="img"` 的先例未被徽标沿用；无角色/名称断言。 | P2 | 已修正 `ca10c5c3`：徽标改为 `role="img"` + 中文 `aria-label`；E2E 改为 `toHaveRole("img")` + `toHaveAccessibleName`；CDP `Accessibility.getFullAXTree` 实测 `role=image`、`name=庄家/小盲/大盲`。 |
| F-02 | 人工验收（2026-09-16）：`poker-table/README.md` 声称徽标“不增加座位高度” | 确认。移动端昵称行因 16px 徽标比 15px 行高多约 1px，与文档不符。 | E2E 已断言座位矩形互不相交；无文档一致性检查。 | P3 | 已修正 `ca10c5c3`：文档改为“桌面端不增加座位高度，移动端昵称行最多增加约 1px”。 |
| F-03 | Greptile [`#discussion_r4032241364`](https://github.com/fujiabao89/Texas-Holdem/pull/55#discussion_r4032241364)（原文 P2，非阻断）：fixtures 注入服务端不会产生的投影 | 确认。Heads-up 用例把已弃牌且无底牌的 `player-2` 设为当前行动者；淘汰用 `PLAYER_CHECKED` 的 patch 表达，而非 `PLAYER_ELIMINATED` 生命周期事件。违反 [06 §3.3](../06-testing-strategy.md) “以 Fake WebSocket 注入合法投影”，并削弱弃牌/淘汰稳定性的证据强度。 | 映射纯函数单测覆盖状态变化；E2E 只断言槽位不变，未校验事件形态。 | P2 | 已修正 `ce91c405`：弃牌改为当前行动者本人弃牌并进入 `HAND_END`、`currentActorPlayerId: null`；淘汰改用 `PLAYER_ELIMINATED` 事件并置 `HAND_END`、`stack: 0`；跨手 `HAND_STARTED` 同步设置新行动者；座位槽位断言不变。 |
| F-04 | Codex `chatgpt-codex-connector[bot]`（reviewed `ca10c5c369`） | 结论“Didn't find any major issues”，无内联意见。 | — | 无需处置 | 无修改；新提交后如需重审由用户手动触发。 |
| F-05 | CodeRabbit `coderabbitai[bot]` | 结论“未发现可确认且可操作的 P0/P1/P2/P3 问题”；仓库自动审查关闭，仅执行分析链回复。 | — | 无需处置 | 无修改。 |
| F-06 | Copilot PR Reviewer / Qodo | Copilot 配额受限、Qodo 计费暂停，均未产出审查内容；Vercel 部署与 Linear linkback 不属于审查意见。 | — | 无内容 | 无修改。 |

## 验证记录

已执行并通过：

- `pnpm exec playwright test -c tests/e2e/playwright.config.ts seats --workers=1`（5 项，修复后复跑）；
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=2`（49 项，含 seats 5 项与既有 TEX-38 十人桌、betting、observability）；
- `pnpm test:unit`（84 文件、856 项；其中一次运行出现 1 项未复现失败，随后两次全量运行全绿）；
- `pnpm lint`、`pnpm typecheck`、`git diff --check`。

所有已修正项均以当前分支代码、Playwright 用例或 Chromium 可访问性树实测验证；未引入协议、投影或服务端改动。
