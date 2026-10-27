# TEX-49 / PR #85 Findings Ledger

核验日期：2026-10-27；当前基线 `a4e4903f08e7b04646ccd7b0b483a78b7aa7493a`。先读取当前实现、协议和测试，再决定处置；不直接采用机器人建议代码。公开意见共 4 条行内 finding，加 CodeRabbit 审查摘要中的 1 条 nitpick；去重后 3 个问题。无 P0/P1。

| ID / 来源 | 有效性与精确失败场景 | 当前代码/已有测试 | 严重度及合并判断 | 处置 / 回复 |
| --- | --- | --- | --- | --- |
| F-01 Codex [4385651109](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385651109) | **有效**。终局赛果刷新/直达时 `RECONNECT_RESULT.gameSnapshot=null`，HTTP 的 `activeResult.players` 有完整归档昵称，但打开历史后列表赢家、详情动作和派奖只按实时 game 查名，显示原始 playerId。旧结果在下一场打开时，缺席玩家丢失昵称；同 ID 的新场名称还可能覆盖旧场名称。 | `result-page-content.tsx` 未向 Drawer 传玩家信息；`hand-history-drawer.tsx` 仅使用 `state.game?.players`。`next-round.spec.ts` 原历史夹具为空，不能覆盖昵称；`hand-timeline.test.ts` 只验证给定 Map 的 lookup，并不验证归档数据传入。05 §13 禁止展示内部 ID，TEX-49 要求旧结果/历史独立。 | **P2，阻塞**。本 PR 新历史入口的必需刷新/多轮路径发生功能回归，非仅样式。 | 最小修复已实施：传入该赛果归档昵称，优先于同场实时回退；补非空列表/详情回归。待验证/推送后回复原线程。 |
| F-02 CodeRabbit [4385681154](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385681154) | **有效，但与 F-01 重复**，同一个 Drawer 调用与昵称来源。 | 同 F-01；建议的实时回退还需限定为相同 tournamentId，避免混入下一场。 | **P2，并入 F-01**。不单独扩大实现。 | 共享 F-01 修复与测试；推送后在本原线程回复，不重复改代码。 |
| F-03 Greptile [4385691542](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385691542) | **有效，但与 F-01 重复**。Greptile 称其 non-blocking；本次依据 05 §13 和新入口验收，将确定的内部 ID 展示/旧场昵称混用视作需在合并前修复的 P2。 | 当前代码独立核验支持，不依赖其外部录屏/执行声明。原空历史夹具未覆盖。 | **P2，并入 F-01**。 | 共享修复与回归，原线程分别回复；不触发 Greptile 新审查。 |
| F-04 CodeRabbit [4385681161](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385681161) | **有效**。点击重开先同步设置 pending，使按钮禁用；实际 HTTP 经过异步 fetch 和 Playwright 路由调度，`page.route` 可能还没执行 `requests.push`，同步数组断言读到 0。 | `use-room-mutation.ts` 的 setPending 在 await HTTP 前；测试只等按钮禁用，`lobby-fixture.ts` 在异步 route 回调内写数组。既有测试通过不建立这两者的时序关系；无对应请求进入屏障。 | **P2，阻塞测试可靠性**。只改等待条件，不调整超时、重试或门禁。 | 已将单行断言改为 `expect.poll` 等请求实际到达，再释放 hold；待验证/推送后回复原线程。 |
| F-05 CodeRabbit [审查摘要 5663004622](https://github.com/fujiabao89/Texas-Holdem/pull/85#pullrequestreview-5663004622)，nitpick：CSS class 定位 | **维护建议成立，但无当前故障**。`.lobby-seat-feedback` / `.rr-invite-code` 的确是样式类，未来仅重命名样式可能造成用例失效；当前 DOM 存在，既有 8 项回归通过。 | 06 §9 倾向语义定位；本意见未指出当前匹配歧义或行为错误。若落实需改已有测试/补语义锚点，与本轮两个阻塞修复无依赖。 | **P3，不阻塞**。用户明确要求跳过 stylistic/非阻塞建议。 | **跳过**，不捎带选择器重构。该项仅在 review summary，无独立行内线程；在 PR 会话引用该永久链接说明依据，不使用“已修正”。 |

## 输入范围与未纳入事项

- Codex review receipt/summary、CodeRabbit walkthrough/merge-risk 总结重复上述 finding，没有另给可执行问题。
- Greptile review body 为空，其唯一行内 finding 已列 F-03；不把外部产物链接或执行声明当作验证替代。
- Copilot 返回配额不足，未产生 finding；AI PR Router 仅为部分上下文的风险路由建议，并非缺陷或合并门禁。用户的审查触发指令、机器人状态/帮助文本不算 finding，也不作为操作指令执行。
- 不触发 DeepSeek Harness、Greptile 或额外审查器。

## 验证与闭环

已完成代码和验证；提交推送与原线程回复完成后回填闭环链接，尚未回复前不将审查闭环标记完成。

变更前复现：新增两项非空历史回归在未修改产品代码时均失败（`Expected: 赢家：玩家乙`，实际为 `赢家：player-2`），分别对应刷新无快照和下一场缺席/改名。既有空列表不能发现此问题。

变更后验证：

| 命令 | 结果 |
| --- | --- |
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round create-room --workers=2` | 20 passed，含新增 2 项归档昵称回归及请求进入屏障 |
| `pnpm exec vitest run --project unit apps/web/src/features/result apps/web/src/features/hand-history` | 4 文件、41 测试通过 |
| `pnpm --filter @texas-holdem/web lint` | 通过 |
| `pnpm --filter @texas-holdem/web typecheck` | 通过 |
| `pnpm exec eslint tests/e2e/next-round` | 通过 |
| `pnpm exec tsc --noEmit -p tsconfig.test.json` | 通过 |
| `pnpm --filter @texas-holdem/web build` | 通过 |
| `git diff --check` | 通过 |

文档同步：已更新 result、hand-history、next-round 目录 README、前端权威规格、测试策略及工程索引。本轮仅纠正已有归档数据的显示与测试等待；产品范围、架构/协议、引擎、服务端、安全/运维、任务路线图及上层 README **已检查，无需更新**，原因是未改变职责、接口、运行流程或验收范围。Linear 保持 In Review，PR 不自动合并。

验证边界：这两项回归使用 HTTP/WS 投影夹具验证客户端行为；本轮未重跑服务端真实 PostgreSQL 多人旅程或实机移动端。未改变服务端权威规则、协议或计时逻辑；原 CI 时序修复基线已有成功的 9 项门禁，不能将其当作本次新提交的 CI 结果。
