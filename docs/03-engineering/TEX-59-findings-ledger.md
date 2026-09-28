# TEX-59 / PR #59 Findings Ledger

复核日期：2026-09-28。原审查基线：`72e889a4e03baa370e678a76d5b80ff07e5b9a68`；已验证首轮修复并推送至 PR 源分支（`392385e6`）。逐项检查了五条 inline finding（Greptile 两条、CodeRabbit 三条）、Greptile 汇总评论中的两条重复 finding 与 CodeRabbit 总结中的一条质量警告。CodeRabbit 对 `2259141f` 的增量审查新增 F-08；9 月 25 日和 28 日的 `@codex review` 请求均未产生 Codex 审查结果或 finding。未启动新的 Greptile 审查。

## 逐条核验

| ID | 来源 | 有效性、精确场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Greptile 4102356374](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102356374) | 有效。`SHOWDOWN_DISPLAY` 期间触发 writer 恢复或撤回时，`afterEngineTransition()` 再次调用 `advance()`；结算手已结束，旧分支会清展示 Timer 并开始下一手。修复前 Fake Clock 复现：四秒窗口进行一秒后恢复背压，立即进入下一手的 `DEALING`。原测试只覆盖 Timer 自然到期，没有覆盖窗口内恢复/撤回。 | P1 | 修复：无进行中手且摊牌窗口仍活动时，`advance()` 提前返回；外层仍发出命令产生的事件，展示 Timer 到期后才继续推进。新增三条回归测试。 |
| F-02 | [CodeRabbit 4102363177](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102363177) | 有效，与 F-01 是同一根因，并补充状态不变量场景：背压仍暂停时撤回玩家，旧逻辑将阶段改为 `BETWEEN_HANDS` 后停在手间边界，却保留非空 `showdownDisplayUntil`。修复前测试观察到此不一致；Schema 要求只有 `SHOWDOWN_DISPLAY` 才能带非空截止线。 | P1 | 合并到 F-01 修复；新增暂停状态下撤回的回归测试，不重复实现。 |
| F-03 | [Greptile 4102356362](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102356362) | 有效。结算尾部事件的 Patch 按逐事件 Engine 状态投影；`POT_AWARDED` 的 Patch 可先带 `HAND_END`，之后才请求 `SHOWDOWN_DISPLAY` 权威 Snapshot。当前测试未断言这两个阶段的短暂切换。 | P2 | 跳过运行时修改：Greptile 明确将其评为非阻塞显示不一致；该 Patch 后接同一 sequence 的权威展示 Snapshot，不提前开始下一手或改变结算结果。协议文档另按 F-04 校正为当前实际时序。 |
| F-04 | [CodeRabbit 4102363189](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102363189) | 有效。`docs/02-protocol-spec.md` §8.4.1 原称 `HAND_END` 只在展示截止后公开；但 F-03 的逐事件 Patch 可能更早携带 `HAND_END`。这不是代码行为的测试覆盖问题，而是规范与实际 wire 消息矛盾。 | P2 | 修正文档：区分 Engine 逐事件 Patch 与 `SHOWDOWN_DISPLAY` 权威 Snapshot，并说明窗口到期后发布 `HAND_END` Snapshot。该权威协议描述必须与当前 wire 行为一致；不扩展为事件投影重构。 |
| F-05 | [CodeRabbit 5755729815](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5755729815) | 质量警告：CodeRabbit 统计 diff 中 21 个函数的 docstring 覆盖率为 47.62%，低于其 80% 建议值；仓库 `.coderabbit.yaml` 明确将 `docstrings.enabled` 设为 `false`，工程规格也未将此指标设为验收门槛。 | P3 | 跳过：属于非阻塞风格/文档覆盖率建议，不影响行为正确性；按要求不为阈值新增泛化 docstring。 |
| F-06 | [Greptile 汇总评论第 1 条](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5828833194) | 有效，但与 F-03 重复。`SHOWDOWN_STARTED`、`PLAYER_REVEALED`、`POT_AWARDED` 的逐事件 Patch 可能先带 `HAND_END`，权威 Snapshot 随后才进入 `SHOWDOWN_DISPLAY`；现有测试未断言这段短暂切换，没有独立的新失败场景。 | P2 | 跳过重复的运行时修改，按 F-03 的非阻塞结论处理；F-04 已校准权威协议描述。 |
| F-07 | [Greptile 汇总评论第 2 条](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5828833194) | 有效，但与 F-01 重复。背压恢复或玩家撤回在展示窗内再次调用 `advance()`，旧代码会清 Timer 并提前推进；原测试只覆盖自然到期。 | P1 | 合并到 F-01 的同一最小修复及三条回归测试，不重复实现。 |
| F-08 | [CodeRabbit 4122341624](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4122341624) | 有效。§8.4.2 原称展示阶段 Patch 与可选 `CLOCK_UPDATED` 可提供 `showdownDisplayUntil`；当前 `enterShowdownDisplay()` 仅在旧手事件 Patch 后请求权威快照，Event Bus/网关发送 `GAME_SNAPSHOT`，而 `emitClockUpdated()` 只在 Time Bank 延长路径调用。若客户端依旧文档等待展示阶段 Patch/Clock，便取不到展示截止线。现有执行器测试只断言内部截止线，网关测试验证快照请求会发送 Snapshot；没有测试覆盖旧文档的错误说法。 | P2 | 修正 §8.4.2 的消息类型与截止线来源，并同步校正同节客户端义务中将窗口结束消息误称为 `HAND_END` Patch 的一句话；不改运行时或协议 Schema。 |

## 验证与文档同步

- 修复前新增的三条回归用例全部失败，分别复现了提前进入下一手、撤回时提前结束展示、以及暂停边界上的阶段/deadline 不一致。
- 修复后定向回归与执行器、赛事生命周期、恢复及房间生命周期共 6 个测试文件、93 个用例通过。2026-09-28 重新运行 `pnpm exec vitest run --project unit apps/game-server/src --reporter=dot`（32 文件、341 用例通过）、`pnpm test:ws`（2 文件、11 用例通过）、`pnpm --filter @texas-holdem/game-server typecheck`、修改 TS 文件的 ESLint、修改文件的 Prettier 检查和 `git diff --check 72e889a4..HEAD`，全部通过。
- F-08 文档校正后，运行 `pnpm exec vitest run --project unit apps/game-server/src/tournaments/tournament-executor.test.ts apps/game-server/src/realtime/gateway/lobby-gateway.test.ts --reporter=dot`（2 文件、60 用例通过）、两份修改文档的 Prettier 检查与 `git diff --check`，均通过；本次未改运行时或 Schema。
- 已更新 `apps/game-server/src/tournaments/README.md` 的展示 Timer 行为与测试覆盖说明；已校准权威协议规格并将本 Ledger 加入工程索引。
- `docs/04-game-server-architecture.md`、`docs/06-testing-strategy.md`、`packages/protocol/README.md` 及目录索引已检查，无需更新：未改变模块边界、Schema、测试方法、公开接口或目录职责。安全、运维与产品范围文档也无需更新。
- Linear 连接要求重新认证，本次无法读取 TEX-59 issue 验收字段；仓库内未找到独立的 TEX-59 任务卡。按 PR 描述、关联的 TEX-58 协议规格和当前代码完成了本次 review 核验。

## 回复闭环

修复推送后，F-01 [4122128485](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4122128485)、F-02 [4122128922](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4122128922) 与 F-04 [4122129566](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4122129566) 均在原 inline 线程回复“已修正”。F-03 已在原线程 [4103766390](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4103766390) 说明非阻塞依据；原四条 inline 线程均显示已解决。F-05 已在 PR 对话 [5831118979](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5831118979) 说明跳过原因。F-06/F-07 所在的 Greptile 汇总评论是普通 PR 对话评论，没有独立回复线程；已在 [5869842893](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5869842893) 链接原评论并分别说明重复处置。F-08 待新文档修正通过验证并推送后在原 inline 线程回复。Codex 没有已发布的 finding 线程可回复。
