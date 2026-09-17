# TEX-58 / PR #54 Findings Ledger

复核日期：2026-09-16。基线：`f7024c71128a0759d8dd7465c882407d0663f5e5`。来源为 GitHub PR #54 全部审查线程（9 条，包含 Codex、Greptile 与 CodeRabbit）；未主动触发新的自动化审阅。

## 逐条核验

| ID | 来源 | 有效性、精确场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Codex 4026504727](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504727) | **有效**。在严格 Zod Schema（`GameSnapshotSchema`、`CLOCK_UPDATED`）中将 `showdownDisplayUntil` 作为必填字段（可为 null），但 `PROTOCOL_VERSION` 保持为 4。混用旧服务端与新客户端、或旧客户端与新服务端时，消息被 Zod strict 校验拦截为 `INVALID_MESSAGE` 并触发无效重试，绕过了通过 `UNSUPPORTED_PROTOCOL_VERSION` 提示用户刷新/升级的正常握手门禁。 | P1 | **修复**：在 `packages/protocol/src/schemas/common.ts` 将 `PROTOCOL_VERSION` 提升至 5；同步更新协议规格、各目录 README 与测试。 |
| F-02 | [Codex 4026504734](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504734) | **范围界定**。指出真实运行时未实际生成 `SHOWDOWN_DISPLAY` 阶段，因为 `projectionInputFor()` 始终输入 null。经查 Linear 路线图，服务端权威展示定时器与延迟开启时钟的完整运行时编排已被独立拆分为后续任务 [TEX-59]（`服务端在展示阶段结束后开启行动时钟`），TEX-58 的职责范围为定义阶段与时钟契约。若在本 PR 强行重构 `tournament-executor.ts`，将侵入 TEX-59 边界并打破现有测试与仿真套件。 | P1 | **限定规格边界**：在 `docs/02-protocol-spec.md` §8.4.1 与 `apps/game-server/src/projection/state-projector.ts` 注释中明确：TEX-58 定义协议阶段与时钟契约，运行时 `tournament-executor` 处于过渡期（`showdownDisplayUntil` 目前为 `null`，手牌在 `POT_AWARDED` 后仍经由 `HAND_END` 推进），服务端权威展示定时器与延迟开时钟由 [TEX-59] 落地编排。 |
| F-03 | [Codex 4026504739](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504739) | **有效**。`ClockUpdatedPayloadSchema` 原 superRefine 仅校验了 `actionDeadline` 与 `showdownDisplayUntil` 互斥，未约束展示时钟下的行动者，允许出现 `{ currentActorPlayerId: "alice", showdownDisplayUntil: ... }`。由于 `SHOWDOWN_DISPLAY` 阶段无当前行动者（currentActorPlayerId 必为 null），带 action 名字的展示时钟若在下注阶段到达，可能匹配客户端当前的 actor 过滤器并错误覆盖展示时钟。 | P2 | **修复**：在 `ClockUpdatedPayloadSchema` 中增加约束：`showdownDisplayUntil !== null` 时 `currentActorPlayerId` 必须为 `null`。在 `protocol.test.ts` 中补齐拒绝非空 actor 的单测断言。 |
| F-04 | [Codex 4026504746](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504746) | **有效**。`tests/e2e/betting/table.spec.ts:168` 中的 `CLOCK_UPDATED` 模拟消息缺少 `showdownDisplayUntil: null`，导致被 `validateServerMessage` 严格 Schema 拦截并触发 resync 请求，未真实测试按钮收起逻辑。 | P1 | **修复**：在 `tests/e2e/betting/table.spec.ts:168` 中补齐 `showdownDisplayUntil: null`。 |
| F-05 | [Codex 4026504754](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504754) | **有效**。变更了公开协议枚举、快照字段并升级 wire 主版本至 v5，但未同步更新 `packages/protocol/README.md`、`packages/protocol/src/schemas/README.md` 和 `packages/protocol/src/events/README.md`，违反 AGENTS.md 规范与 README 同步要求。 | P1 | **修复**：更新上述三个目录 README，记录 v5 与 TEX-58 契约及互斥校验。 |
| F-06 | [Greptile 4026558193](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026558193) | **重复 (F-02)**。指出 `showdownDisplayUntil` 在真实运行时未被生产且展示相态未被调度。 | P1 | **合并至 F-02**，处理方式同 F-02。单独在 Greptile 评论线程中回复说明。 |
| F-07 | [Greptile 4026558208](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026558208) | **重复 (F-01)**。指出严格 Schema 下新增字段破坏 v4 兼容性，须提升协议主版本。 | P1 | **合并至 F-01**，处理方式同 F-01。单独在 Greptile 评论线程中回复说明。 |
| F-08 | [CodeRabbit 4026612901](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026612901) | **重复 (F-02)**。建议实现服务端权威的摊牌展示状态与定时器。 | Major (P1) | **合并至 F-02**，处理方式同 F-02。单独在 CodeRabbit 评论线程中回复说明。 |
| F-09 | [CodeRabbit 4026612910](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026612910) | **重复 (F-01)**。指出 `showdownDisplayUntil` 必填破坏 strict Schema，需递增 `PROTOCOL_VERSION`。 | Major (P1) | **合并至 F-01**，处理方式同 F-01。单独在 CodeRabbit 评论线程中回复说明。 |
| F-10 | [Codex 4031926337](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4031926337) | **有效**。指出在声明 wire v5 之后，`docs/02-protocol-spec.md:161` 中 `ServerMessage` 规范定义仍为 `protocolVersion: 4`，且 `apps/web/src/protocol/README.md` 与 `apps/game-server/src/realtime/gateway/README.md` 仍写 wire v4。实现若依此规范发射 v4 会被 `PROTOCOL_VERSION = 5` 拒绝。 | P1 | **修复**：将 `docs/02-protocol-spec.md:161` 改为 `protocolVersion: 5`；更新两份 README 为 v5 并说明旧版本拒绝；在 `websocket-transport.test.ts` 与 `lobby-gateway.test.ts` 中增补对 v4 拒绝的直接测试。 |
| F-11 | [CodeRabbit 4031953534](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4031953534) | **有效**。指出 `docs/02-protocol-spec.md:105` 的 `AUTHENTICATE` 示例仍写作 `"protocolVersion": 4`，客户端参照该示例发送会在握手阶段直接触发 `UNSUPPORTED_PROTOCOL_VERSION`。 | Major (P1) | **修复**：将 `docs/02-protocol-spec.md:105` 示例改为 `"protocolVersion": 5`。 |

## 验证

- `pnpm test:unit -- apps/web/src/protocol/websocket-transport.test.ts apps/game-server/src/realtime/gateway/lobby-gateway.test.ts packages/protocol/src/protocol.test.ts`：64/64 全量通过（验证客户端与服务端网关对 v3 与 v4 旧版本首帧/快照的强制拒绝）。
- `pnpm typecheck`：通过（0 错误）。
- `pnpm lint`：通过（0 错误）。

## 原线程闭环

| Finding | 原评论线程 | 计划回复 | 状态 |
| --- | --- | --- | --- |
| F-01 | [Codex 4026504727](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504727) | `已修正` | 已回复 |
| F-02 | [Codex 4026504734](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504734) | 已明确契约与运行时分工：TEX-58 完成展示阶段与时钟契约定义，服务端权威展示定时器与延迟开时钟由后续任务 [TEX-59] 实现编排，已在文档 §8.4.1 与代码注释中明确限定。 | 已回复 |
| F-03 | [Codex 4026504739](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504739) | `已修正` | 已回复 |
| F-04 | [Codex 4026504746](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504746) | `已修正` | 已回复 |
| F-05 | [Codex 4026504754](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026504754) | `已修正` | 已回复 |
| F-06 | [Greptile 4026558193](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026558193) | 已明确契约与运行时分工：TEX-58 完成展示阶段与时钟契约定义，服务端权威展示定时器与延迟开时钟由后续任务 [TEX-59] 实现编排，已在文档 §8.4.1 与代码注释中明确限定。 | 已回复 |
| F-07 | [Greptile 4026558208](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026558208) | `已修正` | 已回复 |
| F-08 | [CodeRabbit 4026612901](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026612901) | 已明确契约与运行时分工：TEX-58 完成展示阶段与时钟契约定义，服务端权威展示定时器与延迟开时钟由后续任务 [TEX-59] 实现编排，已在文档 §8.4.1 与代码注释中明确限定。 | 已回复 |
| F-09 | [CodeRabbit 4026612910](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4026612910) | `已修正` | 已回复 |
| F-10 | [Codex 4031926337](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4031926337) | `已修正` | 已回复 |
| F-11 | [CodeRabbit 4031953534](https://github.com/fujiabao89/Texas-Holdem/pull/54#discussion_r4031953534) | `已修正` | 已回复 |
