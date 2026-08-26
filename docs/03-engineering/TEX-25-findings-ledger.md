# TEX-25 审查 Findings Ledger

审查时间：2026-08-26
范围：PR #27 的当前分支 `feat/TEX-25-implement-poker-table-ui`，逐项复核 Codex、CodeRabbit 与 Greptile 留言；不重新触发任何审查服务。

严重性遵循 [05 前端规格](../05-frontend-spec.md) §16：P1 为阻断主流程或违反已裁决交互；P2 为应在本 PR 修复的可靠性/交互缺陷；P3 为不改变运行时代码正确性的测试增强。

| ID | 来源 / 留言 | 当前代码与失败场景 | 已有防线 / 测试 | 严重性 | 处置 |
| --- | --- | --- | --- | --- | --- |
| F-01 | Codex `#discussion_r3860095898`：倒计时不实时更新 | 确认。`ClockStatus` 只格式化静态截止时间；收到 Snapshot 或 `CLOCK_UPDATED` 后，行动者无法看到秒数递减。 | `ProjectionStore` 已验证只接受当前、非过期的 Clock；无展示倒计时测试。 | P1 | 已修正：以 `serverTime` 和 `performance.now()` 收据锚点推导只读剩余时间，250ms 刷新且不发送本地动作；补充纯函数测试。 |
| F-02 | Codex `#discussion_r3860095904`：终态认证/版本错误被当作接管 | 确认。旧顺序先匹配 `STOPPED`；`AUTH_FAILED` 清 Token 后仍显示“其他设备打开”，`UNSUPPORTED_PROTOCOL_VERSION` 也没有刷新入口。 | Transport 已停止重连并在 `AUTH_FAILED` 清 Token；没有页面级错误恢复测试。 | P1 | 已修正：先按 Token 缺失进入重新加入流程，并保留终态错误用于版本不兼容的刷新入口；新增两条 E2E。 |
| F-03 | Codex `#discussion_r3860095909`：`CLOCK_UPDATED` 后 Time Bank 按钮陈旧 | 确认。计时展示读取 `state.clock`，而按钮读取旧 `game.viewer`；余额变为 0 时仍可重复发送 `USE_TIME_BANK`。 | Projection 测试覆盖 Clock 接收，不覆盖按钮可见性。 | P2 | 已修正：按钮与展示均使用同一权威 clock 投影；新增 E2E。 |
| F-04 | CodeRabbit `#discussion_r3860123644`：有 pending 时仍可重试 | 确认。`USE_TIME_BANK` 设置新 pending 后，旧重试按钮仍可点击，`retry()` 还能覆盖本地 pending 并发送过期命令。 | `canSubmitTableAction` 会阻止主操作，但旧 retry 不受它约束；无并发 retry E2E。 | P2 | 已修正：retry 函数与按钮都以 `hasPendingCommand` 为门禁；新增 E2E。 |
| F-05 | CodeRabbit `#discussion_r3860123648`：重试未恢复 `SENDING` | 确认。被拒命令的对象状态为 `REJECTED`；`send()` 原样保存，重连时 `retryUnresolvedPending()` 只发 `SENDING`，所以已手动重试的命令在断线后丢失自动重发。 | 已有断线重发测试只覆盖原始 `SENDING` 命令。 | P2 | 已修正：页面重试时创建相同字节、相同请求/动作 ID 且状态恢复为 `SENDING` 的命令；新增 Fake WebSocket + Fake Clock 回归。 |
| F-06 | CodeRabbit `#discussion_r3860123650`：E2E 未完整断言命令信封且反馈/Event 同回调 | 部分成立，但不构成运行时缺陷。若页面绕过 `prepareSubmitAction`，该 E2E 可能漏报信封字段；同回调也降低“Event 才推进投影”的 E2E 证明力。 | `WebSocketTransport` 单元测试已断言 `requestId`、`actionId`、`expectedSequence`，且 `COMMAND_RESULT` 不写入 canonical game state。 | P3 | 不修改：这是重复的测试强化建议，未发现当前实现未受覆盖的失败行为；保持本 PR 最小变更。 |
| F-07 | CodeRabbit `#discussion_r3860123654`：Session Replaced E2E 未先加载活跃牌桌后再关闭 4001 | 部分成立，但不构成运行时缺陷。现有 E2E 只验证阻断提示；可更贴近协议时序。 | Transport 单元测试已在真实 projection 后发送 `SESSION_REPLACED`，断言 `STOPPED`、最后投影不变；页面在 `STOPPED` 时移除操作区。 | P3 | 不修改：建议属于覆盖深度提升，现有 Transport + 页面 E2E 已覆盖实际终态，不增加额外非阻断 E2E。 |
| F-08 | Greptile `#discussion_r3860183908`：普通下注达到 `allInTo` 绕过两步全下 | 确认。Slider/精确金额到达 `allInTo` 时，`submitAmount()` 直接发送 `BET`/`RAISE`，违反 05 §8.2/§8.5 的命令语义与二次确认。 | 既有 E2E 仅覆盖独立 All-in 按钮，不覆盖普通下注区间终点等于 `allInTo`。 | P1 | 已修正：该端点进入 All-in 确认态，第二次点击只提交 `ALL_IN`；新增 E2E。 |
| F-09 | Greptile `#discussion_r3860265739`：Time Bank 可用性陈旧 | 重复，当前代码不成立。`BettingControls` 已接收 `state.clock` 派生的 `actionDeadline` 与 `timeBankRemainingMs`，不再读取陈旧 `game` 字段。 | F-03 新增的 `CLOCK_UPDATED` → 余额为 0 → 按钮消失 E2E 已通过。 | P3 | 不修改：与 F-03 为同一问题，已由 `1b6199d8` 修正；仅登记并关闭重复线程。 |
| F-10 | CodeRabbit `#discussion_r3861204815`：重连重发测试可能匹配历史发送记录 | 确认。Fake WebSocket 会保留断线前的 `sent`；仅断言最后一条等于原命令，若重连后没有重发而旧记录恰好仍在末尾，测试可误通过。 | 原测试覆盖了重连流程，但没有记录重连前发送边界。 | P2 | 已修正：在断线前保存发送数，断言重连后有新增记录且新增记录包含原始序列化命令。 |
| F-11 | Greptile `#discussion_r3861249297`：改选普通下注后全下确认态残留 | 确认。先点击 All-in 后改选 Bet/Raise 或调整金额，`allInConfirmSequence` 保持当前序列；再次点击 All-in 会直接提交 `ALL_IN`，无视新选择的普通下注。 | 原 All-in E2E 只覆盖两次点击和普通端点转全下，未覆盖确认态后改选金额。 | P1 | 已修正：选择普通 Bet/Raise 模式或任何普通金额时清除确认态；新增 E2E 断言随后提交 `RAISE` 而非 `ALL_IN`。 |

## 验证记录

已执行并通过：

- `pnpm exec vitest run --project unit apps/web/src/features/poker-table/table-state.test.ts apps/web/src/protocol/websocket-transport.test.ts apps/web/src/state/projection-store.test.ts apps/web/src/protocol/token-store.test.ts`（29 项）；
- `pnpm exec vitest run --project unit apps/web/src/protocol/websocket-transport.test.ts`（13 项，F-10）；
- `pnpm test:unit`（48 文件、430 项）；
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/betting/table.spec.ts`（11 项，含 F-11）；
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 与 `git diff --check`。

所有已修正项均以当前分支代码、Fake WebSocket/Fake Clock 单元测试或直接相关 E2E 验证；没有引入平行投影、连接或协议 DTO。
