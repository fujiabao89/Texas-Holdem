# Schemas

共享通用字段、Snapshot/View 和投影的运行时校验。`projection.ts` 只接收明确列出的最小服务端源字段，并以 allow-list 重建 PlayerView/BotView；不会展开或透传内部状态。
