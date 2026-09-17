# Observability

TEX-52：`texas_active_tournaments` 仅统计 RUNNING；新增 registered tournaments、finished-retained tournaments、frozen tournaments、registered rooms、closed-room tombstones、registered Writer queues 的 gauge，避免历史驻留数量冒充活跃量。精确名称在 `server-metrics.ts`，全部无 room/player 标签。保留期内 registered 大于 active 属正常；过期后应回落，未提交/隔离 Writer 队列按真实积压保留。

日志、指标、链路追踪、审计事件和告警适配。
