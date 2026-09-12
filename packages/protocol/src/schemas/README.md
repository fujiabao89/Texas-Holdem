# Schemas

共享通用字段、Snapshot/View 和投影的运行时校验。`projection.ts` 只接收明确列出的最小服务端源字段，并以 allow-list 重建 PlayerView/BotView；不会展开或透传内部状态。

`common.ts` 的 `PROTOCOL_VERSION` 是客户端、服务端和测试夹具共同使用的版本来源；TEX-53 提升到 v4，兼容策略见协议规格 §4.1 / ADR-0003。完整 PlayerView/BotView/GameSnapshot 必填 smallBlindSeat/bigBlindSeat，patch 支持可选与 null 清空；最小源模型与 allow-list 投影同步这两个公开字段。
