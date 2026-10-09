# 实时背压与牌局诊断（TEX-61）

适用范围为 game-server 的有界出站队列与普通诊断。wire 仍为 v6，无数据库迁移；精确阈值及恢复契约以 [04 §9.5/§10.5](../04-game-server-architecture.md#95-事件积压与-fast-forward) 和 [02 §10](../02-protocol-spec.md#10-连接生命周期与重连) 为准。

## 发布身份与保留

部署时注入 `APP_VERSION`（1–64 位字母/数字/点/下划线/连字符）与 `DEPLOYMENT_SHA`（7–40 位十六进制 Git SHA）。`GET /health` 返回 `{status:"ok",build:{version,deploymentSha}}`，响应 no-store。缺省为 0.1.0/null，非法值降为 unknown/null；null 不代表已验证线上提交。部署前后对比 SHA，再查看同 SHA 的诊断 JSON 行，不通过打印整个环境排查版本。

生产 main.ts 使用 stdout JSON 行输出诊断，不开启认证帧/请求 Body 追踪。采集端按既有 [06 §10.2](../06-testing-strategy.md#102-监控验收工程基线) 配置应用日志 30 天、指标 90 天、审计及 Release 证据 180 天；日志访问仅运维/授权开发人员，不能作为公开 API。仓库提供日志格式与查询，不负责部署环境的日志采集器、轮转或真实通知渠道；上线必须核验保留及告警送达。

## 查询与区分

按部署 SHA、时间窗口、roomId/tournamentId/handId 查询 JSON 字段；禁止按实体 ID 建 Prometheus 标签。

| 现象 | 证据 |
| --- | --- |
| 怀疑同一手重复开局 | 对同一部署进程与 tournamentId/handId 统计 event=HAND_STARTED；它在权威序列分配点记录一次，与连接数量无关。重连、重复 START 和 Snapshot 不产生该记录。跨进程查询先排除日志采集重复入库。 |
| 自动弃牌/自动过牌 | AUTO_ACTION 的 action=fold/check、trigger=SYSTEM_TIMER_ACTION，关联旧手 handId、generation、deadline、firedAt、delayMs。 |
| 旧 Timer 误触发 | TIMER_IGNORED 的 trigger=hand/phase/actor/generation/deadline/terminal/frozen/reconnected/tournament，对照传入 generation 和 currentGeneration；它是 no-op，不能当成实际自动动作。 |
| 展示/街阶段切换 | PHASE_CHANGED 携带 phase 与 trigger，DEALING/ACTION_OPEN/SHOWDOWN_DISPLAY/BETWEEN_HANDS 由权威流程记录；FLOP/TURN/RIVER 仅记录阶段，不记录牌面。 |
| 断线恢复 | CONNECTION_CHANGED 的 CONNECTED/DISCONNECTED 与 SNAPSHOT_SENT 的 INITIAL/RECONNECT。有效成员重连保持原身份。 |
| 服务端慢连接追赶 | RESYNC_REQUIRED 的 events/age/bytes 与 SNAPSHOT_SENT 的 BACKPRESSURE；恢复快照用最新 handId/sequence 覆盖旧手。 |
| 客户端主动追赶 | SNAPSHOT_REQUESTED 的 MANUAL/GAP/INVALID_EVENT/STALE_ACTION，随后 SNAPSHOT_SENT 的 RESYNC。客户端本地动画播放进度不在服务端观测范围。 |
| 操作晚到/重复 | ACTION_RESULT 的 receivedAt/deadline/errorCode/duplicate，trigger=late/duplicate/APPLIED/REJECTED；Action 与 Time Bank 都先按既有幂等账本裁决。 |
| 超限断连 | SLOW_CONNECTION_CLOSED 的 hard_bytes/recovery_timeout；transport_error 表示出站传输失败。客户端收到 1013 后走既有退避重新认证，不能无限立即重试。 |

一个 HAND_STARTED 日志无法单独证明客户端只展示了一次；应结合快照屏障与浏览器证据。SNAPSHOT_REQUESTED 只证明请求进入网关，可能因权限拒绝或合并而没有独立快照。SNAPSHOT_SENT 表示 send callback 成功，不表示浏览器消费完成；丢失回调/长期积压不能宣称恢复成功。

日志与指标出口分别隔离失败，不能中断出站恢复。若安全日志中的 delayMs 为负，应核验服务端墙钟校正；直方图会拒绝该样本而发送流程继续，不能将缺失样本解释为零延迟。已撤销成员的回执等待独立遵循 04 §9.5 的上限，不依赖已取消的心跳。

## 指标与告警排查

精确名字及标签定义在 [server-metrics.ts](../../apps/game-server/src/observability/server-metrics.ts)，不在文档维护平行目录。新增指标可按以下查询观测：

```promql
sum by (trigger) (increase(texas_resync_required_total[5m]))
sum by (trigger) (increase(texas_slow_connections_closed_total[5m]))
sum by (action) (increase(texas_auto_actions_total[5m]))
sum by (trigger) (increase(texas_stale_timers_total[5m]))
increase(texas_late_actions_total[5m])
increase(texas_duplicate_actions_total[5m])
histogram_quantile(0.95, sum by (le) (rate(texas_resync_recovery_seconds_bucket[5m])))
histogram_quantile(0.95, sum by (le) (rate(texas_action_timer_delay_seconds_bucket[5m])))
```

既有 WS 关闭面板会显示 category=slow；自动 Fold 本身不代表故障，过期 Timer 正确被丢弃也不代表开局重复。告警阈值：按 [06 §10.2](../06-testing-strategy.md#102-监控验收工程基线) 的 P1 断连门槛，当慢关闭占连接建立数超过 5%、10 分钟内至少 20 个连接且持续 10 分钟时调查/通知；恢复耗时接近 30 秒应对照 recovery_timeout 日志。重同步计数增长仅作为排查信号，不逐条报警。运行时遇 hard_bytes/30 秒超时立即隔离该连接，不暂停整桌。

故障处理依次核验：

1. 对比 /health 的 SHA 与日志身份，确认用户实际连接的服务端版本。
2. 比较慢关闭与正常接收者的快照/事件。只有单个接收者背压时查终端网络、长时间后台或慢设备；多连接同时发生时查出站网络、CPU/事件循环和进程内存。
3. 按 handId 查 HAND_STARTED、PHASE_CHANGED、AUTO_ACTION 和 TIMER_IGNORED，区分实际权威执行与旧回调/客户端视觉追赶。
4. 核对最新 Snapshot 的 handId/sequence；查看快照之后是否仍有不高于屏障的事件。发生错误时保存脱敏字段，不上传原始牌局 Payload/凭证。
5. 回滚 game-server 后再次核验 /health；本任务无协议/迁移升级，既有 wire v6 兼容。浏览器弱网时序完整门禁和实际通知渠道验证仍需 TEX-62/部署验收。
