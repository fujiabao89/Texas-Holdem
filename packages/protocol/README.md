# Protocol

`@texas-holdem/protocol` 是客户端与服务端唯一的通信事实来源（TEX-17）。它提供严格的 Zod 运行时 Schema，并只导出由 Schema 推导出的 TypeScript 类型；应用不得维护平行 DTO。

公开入口为 `src/index.ts`：

- `commands`：HTTP 请求、WS Client Command、幂等与版本校验；
- `events`：Server Message、Game Event、`CLOCK_UPDATED` payload、Close Code；
- `errors`：稳定 ErrorCode、严格 ErrorEnvelope 与安全错误构造器；
- `schemas/views`：Room/Game Snapshot、PlayerView/BotView 和 Patch；
- `schemas/projection`：最小服务端源模型、纯投影、私有发牌事件过滤与 Patch 应用。

所有对象 Schema 均为 strict；金额是安全整数，sequence/revision 为 uint64 十进制字符串，协议版本固定为 v5（完整视图必填公开盲注座位，见 [ADR-0005](../../docs/adr/0005-tex-53-authoritative-blind-seats.md)；引入牌局展示阶段 SHOWDOWN_DISPLAY 与权威行动时钟契约，见 [TEX-58](../../docs/02-protocol-spec.md#841-showdown_display-展示阶段)）。此包不依赖数据库、网络框架、UI 或 `poker-engine`，也不裁决扑克动作。权威 wire 语义见 [协议规格](../../docs/02-protocol-spec.md)。

验证：`pnpm test:unit -- packages/protocol/src/protocol.test.ts`、`pnpm --filter @texas-holdem/protocol typecheck`。

TEX-54：`schemas/http.ts` 导出 `TournamentResultParamsSchema`、`TournamentResultQuerySchema`、`TournamentResultSchema`、`TournamentResultResponseSchema` 及推导类型；排名复用导出的 `RankingViewSchema`。增加三个 HTTP 赛果错误码；新增 HTTP 接口不改变既有 WebSocket 主版本，以共享 `PROTOCOL_VERSION` / 02 §4.1 为准。契约/语义与隐私测试：`pnpm exec vitest run --project unit packages/protocol/src/tournament-result.test.ts`。

TEX-58：在 `schemas/views.ts` 与 `events/index.ts` 引入 `SHOWDOWN_DISPLAY` 阶段枚举、`showdownDisplayUntil` 快照与旁路时钟字段，并强制执行跨字段互斥校验（展示阶段 actionDeadline 与 currentActorPlayerId 必须为 null；展示时钟非空时 currentActorPlayerId 必须为 null；非展示阶段 showdownDisplayUntil 必须为 null）。协议主版本提升至 v5。

TEX-59 在 game-server 运行时启用 TEX-58 的既有字段：摊牌和发牌展示窗期间隐藏行动权，窗口结束后以同 sequence 的 `GAME_SNAPSHOT` 原子公开 actor、LegalActions 与完整 deadline。该实现没有新增 wire DTO 或事件，协议仍为 v5。
