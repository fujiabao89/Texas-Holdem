# Protocol

`@texas-holdem/protocol` 是客户端与服务端唯一的通信事实来源（TEX-17）。它提供严格的 Zod 运行时 Schema，并只导出由 Schema 推导出的 TypeScript 类型；应用不得维护平行 DTO。

公开入口为 `src/index.ts`：

- `commands`：HTTP 请求、WS Client Command、幂等与版本校验；
- `events`：Server Message、Game Event、`CLOCK_UPDATED` payload、Close Code；
- `errors`：稳定 ErrorCode、严格 ErrorEnvelope 与安全错误构造器；
- `schemas/views`：Room/Game Snapshot、PlayerView/BotView 和 Patch；
- `schemas/projection`：最小服务端源模型、纯投影、私有发牌事件过滤与 Patch 应用。

所有对象 Schema 均为 strict；金额是安全整数，sequence/revision 为 uint64 十进制字符串，协议版本固定为 v3（无冠军终局，见 [ADR-0002](../../docs/adr/0002-tex-36-championless-history.md)）。此包不依赖数据库、网络框架、UI 或 `poker-engine`，也不裁决扑克动作。权威 wire 语义见 [协议规格](../../docs/02-protocol-spec.md)。

验证：`pnpm test:unit -- packages/protocol/src/protocol.test.ts`、`pnpm --filter @texas-holdem/protocol typecheck`。
