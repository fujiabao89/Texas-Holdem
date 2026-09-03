# TEX-26 审查 Findings Ledger

审查范围：`feat/TEX-26-build-event-animation-audio-and-reconnect-ux`，复核基线为 `dae7636e`。本轮仅检查既有 Codex、CodeRabbit 与 Greptile 意见；未手动启动 Greptile 或 DeepSeek Harness。

| ID | 来源 / 留言 | 有效性、精确失败场景与现有覆盖 | 严重度 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | Codex `3888514690`：Showdown 后未重新判断 Hard Forward | 有效。Showdown 帧已激活且积压超过阈值时，入队保护会抑制 Hard Forward；该帧结束后若没有新 Event，旧实现继续完整播放积压。既有测试只断言保护期间不快进。 | P2 | 已修正：在公开 Showdown 语义帧提交后重新评估；至少保留一个 `PLAYER_REVEALED` 的服务端 Best Five 展示后才清积压。新增 Fake Clock 回归。 |
| F-02 | Codex `3888514698`：Showdown 前提前显示对手牌 | 有效。`SHOWDOWN_STARTED` 的 canonical target 已含多个公开 `revealedCards` 时，Seat 会在逐人 `PLAYER_REVEALED` 之前一次性翻开。既有队列测试未覆盖多名对手的 staged reveal。 | P2 | 已修正：presentation 单独跟踪已完成逐人 reveal 的 playerId；Snapshot 屏障直接对齐终态，正常队列则只在各自 `PLAYER_REVEALED` 完成后显示。新增队列回归。 |
| F-03 | Greptile `3888515138`：关闭 Socket 的快照请求会搁置重连 | 有效。`onclose` 后旧 Socket 仍保留；Hard Forward 调用快照请求会先改为 `RESYNCING`，随后向 CLOSED Socket `send` 抛错，`reconnectNow` 不再创建 Socket。既有重连测试未模拟 CLOSED Socket 的 `send`。 | P1 | 已修正：仅在 OPEN 且已认证连接发送快照，发送成功后才转 `RESYNCING`；失败不改写 `CLOSED`。新增 Fake WebSocket 回归，确认可立即重连。 |
| F-04 | CodeRabbit `3888525099`：投影测试未逐张断言 Best Five | 有效但非阻塞。投影实现直接映射 evaluator 的 `bestFiveCards`，poker-engine 已覆盖精确五张组合；现有 projector 测试另验证公开候选集合。没有实际失败路径。 | P3 | 跳过：这是重复测试粒度建议，不是 PR 阻塞缺陷；保留现有 engine 精确回归与 protocol 必填校验。原线程将说明依据。 |
| F-05 | CodeRabbit `3888525105`：Hard Forward 为 30s，规范为 28s | 有效。积压处于 28–30 秒时，旧代码与 `docs/05` 的行为不一致。现有测试只验证正常两人 all-in 不触发。 | P2 | 已修正：阈值对齐为 28 秒，既有预算测试仍通过。 |
| F-06 | CodeRabbit `3888525114`：`AUTH_FAILED` 被显示成会话接管 | 无效。Transport 先清除该房间 Token；页面先命中无会话分支并提供 `/join`，接管对话框只在 Token 仍在的 `SESSION_REPLACED` 终态出现。`tests/e2e/betting/table.spec.ts` 已覆盖 AUTH_FAILED 重新加入。 | P3 | 跳过：现有代码与 E2E 已处理；原线程将说明依据。 |
| F-07 | CodeRabbit `3888525117`：快照发送失败会搁置恢复 | 有效，与 F-03 同一根因，非独立修复。关闭/竞态 Socket 的 `send` 可能抛出，且状态过早转 `RESYNCING`。 | P1 | 已由 F-03 的最小修复覆盖；同一回归验证。 |
| F-08 | CodeRabbit `3888525119`：连续 Event 未校验 `handId` | 有效。错误 Event 可有连续序列和合法 Patch、但 envelope `handId` 与 Patch 前后手局不一致；canonical 与动画事件身份随后分叉。Clock 已有 handId 校验，Event 没有。 | P1 | 已修正：Patch 解析后要求 envelope handId 与新手局一致（终局清空时允许前一手）；不一致触发 `INVALID_EVENT` resync。新增回归。 |
| F-09 | CodeRabbit `3888525122`：v1 内新增必填 `bestFiveCards` | 有效。旧端发送/接收没有该字段时，会得到 `INVALID_MESSAGE`，但未被明确识别为不兼容主版本。现有版本校验存在，却仍保持 wire v1。 | P1 | 已修正：wire `PROTOCOL_VERSION` 升至 2，全部生产发包复用该常量，测试与协议规范同步；旧端将进入既有 `UNSUPPORTED_PROTOCOL_VERSION` 路径。 |
| F-10 | CodeRabbit 审查摘要：reconnect jitter 使用 `Math.random()` | 有效但低风险。随机退避不是安全令牌，不过违反仓库“生产随机性使用安全源”的约束；测试已注入确定性 random。 | P3 | 已修正：默认改为 `crypto.getRandomValues`，保持测试注入接口。此意见没有独立行级评论线程。 |
| F-11 | CodeRabbit `3891866515`：Showdown 队列测试的 Best Five 夹具无效 | 有效。旧测试的 `bestFiveCards` 含有不在对手底牌或 Board 的牌，且未断言 overlay 透传该服务端字段；错误丢弃 Best Five 的实现仍可能通过。 | P3 | 已修正：构造有效的一对候选牌局，并断言 reveal overlay 的 `bestFiveCards` 与服务端字段完全一致。 |
| F-12 | CodeRabbit `3891866519`：协议规范残留 v1 引用 | 有效。§4.1 已声明 wire v2，但认证示例和两个权威决策仍写 v1；按示例实现会因版本不支持而认证失败。无针对文档一致性的自动测试。 | P1 | 已修正：所有现行认证示例、兼容性说明和 P0 决策表统一为 v2。 |

固定项将在验证、提交和推送后仅回复对应原评论线程“已修正”。跳过项将在原线程说明上述依据，不以“已修正”代替。

## 2026-09-03：PR #28 合并 main 冲突核验

合并基线：TEX-26 `255a554f` + main/TEX-27 `17e5ac78`。用户交接正在进行的手工合并；保留已解决 README 的有效内容。本轮没有新的机器人审查评论，不触发 Greptile 或 DeepSeek Harness。

| ID | 来源 / 核验 | 精确场景与既有覆盖 | 严重度 | 处置 |
| --- | --- | --- | --- | --- |
| M-01 | 牌桌 JSX 冲突与用户合并截图 | 直接接受两边会重复牌桌容器、连接状态；只接受一边则丢失飞牌 ref 或历史入口。已有 E2E 未联合覆盖两个任务的按钮和焦点恢复。 | P1 | 合并为单一牌桌/Deck/连接状态，保留历史、音效、飞牌与重连 effect；新增控件共存、单连接、不发 Action 和键盘关闭历史后焦点返回回归。 |
| M-02 | ProjectionStore 提交冲突 | TEX-26 在提交后通知动画，TEX-27 在提交时记录本手历史；需要一次 replace 同时写入两者。旧历史换手夹具只改 envelope handId，与 TEX-26 已有身份校验不兼容。 | P1 | 保留先校验身份、一次提交 canonical/Clock/history、再通知动画；联合断言通知顺序、重复幂等、Snapshot/重连先清历史再发屏障。换手夹具改为 HAND_STARTED 与 handId Patch 同步推进；不放宽校验。 |
| M-03 | 首轮 pnpm typecheck 实际失败 | main 的 hand-timeline 测试硬编码 wire v1，HandRank 缺少 v2 要求的 bestFiveCards；Vitest 转译运行可通过，但类型检查失败。 | P1 | 仅更新测试夹具：复用 PROTOCOL_VERSION、补合法公开候选 Best Five、移除重复牌；协议与历史生产实现均不改。 |
| M-04 | 牌桌 canonical/presentation 边界复核 | ClockStatus 的 clockKey 在合并前 TEX-26 就读取 presentation；新行动机会事件已应用但动画仍展示旧 actor 时，同截止值的延迟时钟更新可能被旧机会剩余值夹住。原测试仅覆盖 Time Bank 余额。 | P1 | 最小修复为 ClockStatus 的 fallback 与行动机会 key 均读 canonical；新增受控浏览器时钟回归，旧机会剩 1 秒时，新机会立即显示权威 9 秒且公共牌仍在播放、不发 Action。 |
| M-05 | README / 权威规格冲突 | 两边分别把对方功能标记为未实现；docs 索引还残留与 AGENTS.md 相反的自动 DeepSeek 提交门禁描述。 | P3 | 合并两边实施事实、保留归档历史服务端端点缺口；索引按 AGENTS.md 明确仅用户手动启动审查，不增加门禁。 |

验证（2026-09-03）：

- `pnpm test:unit apps/web apps/game-server/src/rooms/room-executor.test.ts apps/game-server/src/realtime`：16 个文件、125 项通过，包含动画/音频、投影/Token/Transport、历史/赛果及已有服务端 Room/实时回归。
- `$env:TEX_E2E_PORT='3116'; pnpm test:e2e tests/e2e/betting/table.spec.ts tests/e2e/reconnect/tex-26.spec.ts --workers=2`：16 项通过，独立测试端口、Fake WebSocket/HTTP 与可控浏览器时钟；无重试。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --check`：通过。首轮 typecheck 的 M-03 错误已修复，重跑通过；构建后的 `next-env.d.ts` 无差异，不提交生成变化。
- README 与 `docs/05`、`docs/06`、文档索引同步。AGENTS/CLAUDE/CONTRIBUTING、任务卡/路线图及其他运维/安全文档已检查，无需更新：无任务范围、服务端生命周期、Transport/Token 契约、素材或部署配置变更。
- main 带入的 `room-executor.ts` 与 `hand-commit.ts` 保持与 `17e5ac78` 一致，没有本轮额外服务端实现。真实 PostgreSQL Integration、真实设备动画/音效人工验收未重跑；归档历史服务端端点的已知缺口仍由独立任务处理。
