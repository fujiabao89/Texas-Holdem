# Schemas

共享通用字段、Snapshot/View 和投影的运行时校验。`projection.ts` 只接收明确列出的最小服务端源字段，并以 allow-list 重建 PlayerView/BotView；不会展开或透传内部状态。

`common.ts` 的 `PROTOCOL_VERSION` 是客户端、服务端和测试夹具共同使用的版本来源；TEX-36 提升到 v3，兼容策略见协议规格 §4.1 / ADR-0002。
