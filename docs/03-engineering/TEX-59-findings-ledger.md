# TEX-59 / PR #59 Findings Ledger

复核日期：2026-09-25。核验基线：`72e889a4e03baa370e678a76d5b80ff07e5b9a68`。逐项检查了 PR #59 的四条 inline review finding（Greptile 两条、CodeRabbit 两条）与 CodeRabbit 总结中的一条质量警告，并检查 PR reviews 与对话评论。Codex 审查请求已发布，但截至复核时没有 Codex 审查结果或 Codex finding。未启动新的 Greptile 审查。

## 逐条核验

| ID | 来源 | 有效性、精确场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Greptile 4102356374](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102356374) | 有效。`SHOWDOWN_DISPLAY` 期间触发 writer 恢复或撤回时，`afterEngineTransition()` 再次调用 `advance()`；结算手已结束，旧分支会清展示 Timer 并开始下一手。修复前 Fake Clock 复现：四秒窗口进行一秒后恢复背压，立即进入下一手的 `DEALING`。原测试只覆盖 Timer 自然到期，没有覆盖窗口内恢复/撤回。 | P1 | 修复：无进行中手且摊牌窗口仍活动时，`advance()` 提前返回；外层仍发出命令产生的事件，展示 Timer 到期后才继续推进。新增三条回归测试。 |
| F-02 | [CodeRabbit 4102363177](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102363177) | 有效，与 F-01 是同一根因，并补充状态不变量场景：背压仍暂停时撤回玩家，旧逻辑将阶段改为 `BETWEEN_HANDS` 后停在手间边界，却保留非空 `showdownDisplayUntil`。修复前测试观察到此不一致；Schema 要求只有 `SHOWDOWN_DISPLAY` 才能带非空截止线。 | P1 | 合并到 F-01 修复；新增暂停状态下撤回的回归测试，不重复实现。 |
| F-03 | [Greptile 4102356362](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102356362) | 有效。结算尾部事件的 Patch 按逐事件 Engine 状态投影；`POT_AWARDED` 的 Patch 可先带 `HAND_END`，之后才请求 `SHOWDOWN_DISPLAY` 权威 Snapshot。当前测试未断言这两个阶段的短暂切换。 | P2 | 跳过运行时修改：Greptile 明确将其评为非阻塞显示不一致；该 Patch 后接同一 sequence 的权威展示 Snapshot，不提前开始下一手或改变结算结果。协议文档另按 F-04 校正为当前实际时序。 |
| F-04 | [CodeRabbit 4102363189](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4102363189) | 有效。`docs/02-protocol-spec.md` §8.4.1 原称 `HAND_END` 只在展示截止后公开；但 F-03 的逐事件 Patch 可能更早携带 `HAND_END`。这不是代码行为的测试覆盖问题，而是规范与实际 wire 消息矛盾。 | P2 | 修正文档：区分 Engine 逐事件 Patch 与 `SHOWDOWN_DISPLAY` 权威 Snapshot，并说明窗口到期后发布 `HAND_END` Snapshot。该权威协议描述必须与当前 wire 行为一致；不扩展为事件投影重构。 |
| F-05 | [CodeRabbit 5755729815](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5755729815) | 质量警告：CodeRabbit 统计 diff 中 21 个函数的 docstring 覆盖率为 47.62%，低于其 80% 建议值；仓库 `.coderabbit.yaml` 明确将 `docstrings.enabled` 设为 `false`，工程规格也未将此指标设为验收门槛。 | P3 | 跳过：属于非阻塞风格/文档覆盖率建议，不影响行为正确性；按要求不为阈值新增泛化 docstring。 |

## 验证与文档同步

- 修复前新增的三条回归用例全部失败，分别复现了提前进入下一手、撤回时提前结束展示、以及暂停边界上的阶段/deadline 不一致。
- 修复后定向回归与执行器、赛事生命周期、恢复及房间生命周期共 6 个测试文件、93 个用例通过；game-server typecheck、修改 TS 文件的 ESLint、修改文件的 Prettier 检查及 `git diff --check` 均通过。
- 已更新 `apps/game-server/src/tournaments/README.md` 的展示 Timer 行为与测试覆盖说明；已校准权威协议规格并将本 Ledger 加入工程索引。
- `docs/04-game-server-architecture.md`、`docs/06-testing-strategy.md` 与 `packages/protocol/README.md` 已检查，无需更新：未改变模块边界、Schema、测试方法或公开接口。安全、运维与产品范围文档也无需更新。
- Linear 连接要求重新认证，本次无法读取 TEX-59 issue 验收字段；仓库内未找到独立的 TEX-59 任务卡。按 PR 描述、关联的 TEX-58 协议规格和当前代码完成了本次 review 核验。

## 回复闭环

F-03 已在原线程 [4103766390](https://github.com/fujiabao89/Texas-Holdem/pull/59#discussion_r4103766390) 说明其非阻塞依据；F-05 已在 PR 对话 [5831118979](https://github.com/fujiabao89/Texas-Holdem/pull/59#issuecomment-5831118979) 说明跳过原因。F-01、F-02 与 F-04 的修复尚未推送，因此尚未回复“已修正”。当前 GitHub 身份对 PR 源仓库 `sizhehao6-glitch/Texas-Holdem` 只有读取权限（`push: false`）；须先取得该源仓库的推送权限，再推送修复并回复三个原始线程。Codex 没有已发布的 finding 线程可回复。
