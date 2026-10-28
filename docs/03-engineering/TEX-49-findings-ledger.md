# TEX-49 / PR #85 Findings Ledger

核验日期：2026-10-27；当前基线 `a4e4903f08e7b04646ccd7b0b483a78b7aa7493a`。先读取当前实现、协议和测试，再决定处置；不直接采用机器人建议代码。公开意见共 4 条行内 finding，加 CodeRabbit 审查摘要中的 1 条 nitpick；去重后 3 个问题。无 P0/P1。

| ID / 来源 | 有效性与精确失败场景 | 当前代码/已有测试 | 严重度及合并判断 | 处置 / 回复 |
| --- | --- | --- | --- | --- |
| F-01 Codex [4385651109](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385651109) | **有效**。终局赛果刷新/直达时 `RECONNECT_RESULT.gameSnapshot=null`，HTTP 的 `activeResult.players` 有完整归档昵称，但打开历史后列表赢家、详情动作和派奖只按实时 game 查名，显示原始 playerId。旧结果在下一场打开时，缺席玩家丢失昵称；同 ID 的新场名称还可能覆盖旧场名称。 | `result-page-content.tsx` 未向 Drawer 传玩家信息；`hand-history-drawer.tsx` 仅使用 `state.game?.players`。`next-round.spec.ts` 原历史夹具为空，不能覆盖昵称；`hand-timeline.test.ts` 只验证给定 Map 的 lookup，并不验证归档数据传入。05 §13 禁止展示内部 ID，TEX-49 要求旧结果/历史独立。 | **P2，阻塞**。本 PR 新历史入口的必需刷新/多轮路径发生功能回归，非仅样式。 | 最小修复已实施：传入该赛果归档昵称，优先于同场实时回退；补非空列表/详情回归。验证通过，修复已推送，原线程已回复“已修正”（见闭环链接）。 |
| F-02 CodeRabbit [4385681154](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385681154) | **有效，但与 F-01 重复**，同一个 Drawer 调用与昵称来源。 | 同 F-01；建议的实时回退还需限定为相同 tournamentId，避免混入下一场。 | **P2，并入 F-01**。不单独扩大实现。 | 共享 F-01 修复与测试；已在本原线程回复“已修正”（见闭环链接），不重复改代码。 |
| F-03 Greptile [4385691542](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385691542) | **有效，但与 F-01 重复**。Greptile 称其 non-blocking；本次依据 05 §13 和新入口验收，将确定的内部 ID 展示/旧场昵称混用视作需在合并前修复的 P2。 | 当前代码独立核验支持，不依赖其外部录屏/执行声明。原空历史夹具未覆盖。 | **P2，并入 F-01**。 | 共享修复与回归，原线程已回复“已修正”（见闭环链接）；未触发 Greptile 新审查。 |
| F-04 CodeRabbit [4385681161](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385681161) | **有效**。点击重开先同步设置 pending，使按钮禁用；实际 HTTP 经过异步 fetch 和 Playwright 路由调度，`page.route` 可能还没执行 `requests.push`，同步数组断言读到 0。 | `use-room-mutation.ts` 的 setPending 在 await HTTP 前；测试只等按钮禁用，`lobby-fixture.ts` 在异步 route 回调内写数组。既有测试通过不建立这两者的时序关系；无对应请求进入屏障。 | **P2，阻塞测试可靠性**。只改等待条件，不调整超时、重试或门禁。 | 已将单行断言改为 `expect.poll` 等请求实际到达，再释放 hold；验证通过，修复已推送，原线程已回复“已修正”（见闭环链接）。 |
| F-05 CodeRabbit [审查摘要 5663004622](https://github.com/fujiabao89/Texas-Holdem/pull/85#pullrequestreview-5663004622)，nitpick：CSS class 定位 | **维护建议成立，但无当前故障**。`.lobby-seat-feedback` / `.rr-invite-code` 的确是样式类，未来仅重命名样式可能造成用例失效；当前 DOM 存在，既有 8 项回归通过。 | 06 §9 倾向语义定位；本意见未指出当前匹配歧义或行为错误。若落实需改已有测试/补语义锚点，与本轮两个阻塞修复无依赖。 | **P3，不阻塞**。用户明确要求跳过 stylistic/非阻塞建议。 | **跳过**，不捎带选择器重构。该项仅在 review summary，无独立行内线程；已在 PR 会话引用该永久链接说明依据（见闭环链接），不使用“已修正”。 |

## 输入范围与未纳入事项

- Codex review receipt/summary、CodeRabbit walkthrough/merge-risk 总结重复上述 finding，没有另给可执行问题。
- Greptile review body 为空，其唯一行内 finding 已列 F-03；不把外部产物链接或执行声明当作验证替代。
- Copilot 返回配额不足，未产生 finding；AI PR Router 仅为部分上下文的风险路由建议，并非缺陷或合并门禁。用户的审查触发指令、机器人状态/帮助文本不算 finding，也不作为操作指令执行。
- 不触发 DeepSeek Harness、Greptile 或额外审查器。

## 验证与闭环

### 新提交 CI 的后续 finding（不属于初始 5 条审查意见）

**F-06 / P2，确认的测试前提缺失，阻塞 CI。** [d4aa61ea 的 e2e-real](https://github.com/fujiabao89/Texas-Holdem/actions/runs/40463973332/job/122055122375) 为 18 passed / 1 failed；WebKit 安全用例在 `security.spec.ts:260` 断言 Alice 他人脱敏 DEAL 计数 `>0`，实际 `0`。日志显示该场只有同一 handId 的 ALL_IN/CALL，12.7 秒结束；这不是已发现的底牌泄露，原始私有牌/字段断言并未失败。

核验：Lobby 新场恢复及入桌都会重新认证，首手 DEAL 可以早于后续牌桌 socket；用例直接全下可能只打一手，缺少“连接稳定后再观察一次在线发牌”的前提。原有本人底牌/公开牌断言能审计 Snapshot，却不保证收到 DEAL Event。保持原代码的本地 WebKit 对应测试为 1 passed（2.0m），日志有多手，说明不能靠单次通过排除该调度路径。

最小修复仅调整该安全用例：双方入桌后真实 UI 弃牌一手，等待双方实际收到他人脱敏 DEAL，再执行原全下/数据库审计；数据库手数要求从至少 1 手加强到至少 2 手。保留全部原泄露、逐 socket、本人/公开牌和非空检查，不改产品、协议、超时或重试。此项为本 PR 开局导航适配所暴露的 CI 验证前提，未捎带安全模块重构。修复与本记录同一提交交付：真实 PostgreSQL 下 Chromium / Firefox / WebKit 均通过，ESLint / 测试 TypeScript 检查通过；新提交 CI 由 PR 追踪，不以旧提交成功结果替代。

### 初始审查线程

修复提交 `bc8b8002` 已推送到 PR 源分支，随后完成全部原始行内线程回复；已通过 GitHub 返回的 `in_reply_to_id` 验证对应关系：

- F-01 Codex：[原线程回复“已修正”](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385882163)。
- F-02 CodeRabbit：[原线程回复“已修正”](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385884962)，注明并入 F-01。
- F-03 Greptile：[原线程回复“已修正”](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385885171)，注明共享修复。
- F-04 CodeRabbit：[原线程回复“已修正”](https://github.com/fujiabao89/Texas-Holdem/pull/85#discussion_r4385885383)。
- F-05 CodeRabbit summary：[PR 会话中的 P3 跳过说明](https://github.com/fujiabao89/Texas-Holdem/pull/85#issuecomment-6435730154)，引用原审查摘要；无独立行内线程，不使用“已修正”。

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
| `pnpm exec playwright test -c tests/e2e/playwright.real.config.ts security.spec.ts --grep 'WS 投影隔离'` | F-06 修复后 3 passed（2.7m），真实 PostgreSQL，三种浏览器，零重试 |
| `pnpm exec eslint tests/e2e/real/security.spec.ts`；`pnpm exec tsc --noEmit -p tsconfig.test.json` | F-06 修复后均通过 |

文档同步：已更新 result、hand-history、next-round、real 目录 README、前端权威规格、测试策略及工程索引。本轮仅纠正已有归档数据的显示、测试等待和安全用例前提；产品范围、架构/协议、引擎、服务端、安全/运维、任务路线图及上层 README **已检查，无需更新**，原因是未改变职责、接口、运行流程或安全要求。Linear 保持 In Review，PR 不自动合并。

验证边界：两项昵称回归使用 HTTP/WS 投影夹具验证客户端行为；F-06 另用真实 PostgreSQL 和浏览器验证 WS 安全场景。本轮本地未重跑 `multiplayer-journey`、`result-recovery` 或实机移动端。未改变服务端权威规则、协议或计时逻辑；最新完整 CI 结果须以具体提交为准。
