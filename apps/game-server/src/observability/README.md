# Observability

TEX-61：`game-diagnostics.ts` 定义普通诊断日志的字段白名单、构建身份和指标适配器。生产 `main.ts` 输出 JSON 行；不开启会记录认证帧的通用请求/Payload 日志。`server-metrics.ts` 注册自动 check/fold、过期 Timer、晚到/重复 Action 与 Time Bank、背压触发/关闭、快照和队列等待/恢复/Timer 延迟指标，标签仅为有限原因或消息类型。`game-diagnostics.test.ts` 覆盖意外附带私密字段的剔除、SHA 校验和计数/延迟；[运行手册](../../../../docs/05-operations/realtime-diagnostics.md) 说明查询及运维边界。


TEX-52：`texas_active_tournaments` 仅统计 RUNNING；新增 registered tournaments、finished-retained tournaments、frozen tournaments、registered rooms、closed-room tombstones、registered Writer queues 的 gauge，避免历史驻留数量冒充活跃量。精确名称在 `server-metrics.ts`，全部无 room/player 标签。保留期内 registered 大于 active 属正常；过期后应回落，未提交/隔离 Writer 队列按真实积压保留。

日志、指标、链路追踪、审计事件和告警适配。
