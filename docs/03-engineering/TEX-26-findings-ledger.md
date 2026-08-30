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

固定项将在验证、提交和推送后仅回复对应原评论线程“已修正”。跳过项将在原线程说明上述依据，不以“已修正”代替。
