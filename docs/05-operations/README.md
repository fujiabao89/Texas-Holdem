# Operations documents

部署、发布、回滚、事故响应和运行维护说明。

## TEX-36 协议升级

wire v3 的客户端与 game-server 必须同时发布或同时回滚；旧主版本按 `UNSUPPORTED_PROTOCOL_VERSION` 拒绝。HTTP 路径仍是 `/api/v1`，不需要数据库迁移，既有 Engine 历史事件在读取时使用新投影。决策见 [ADR-0002](../adr/0002-tex-36-championless-history.md)。

## 可观测性与监控演练（TEX-29）

指标、告警与 Dashboard 的落地配置与本地演练栈见 [infra/monitoring/README.md](../../infra/monitoring/README.md)；权威指标口径与红线见 [docs/06-testing-strategy.md](../06-testing-strategy.md) §10.1/§10.2。

- **指标**：game-server 暴露 `GET /metrics`（Prometheus text exposition）。核心 P0/P1：Action→Event 延迟、WS 打开/关闭分类与消息写出、重连恢复延迟与失败、Action Rejection、持久化 watermark/DEGRADED、Engine Critical Error、Active Rooms/Tournaments、进程内存/CPU。指标保留 90 天、应用日志 30 天、审计/Release 证据 180 天。
- **红线**：任何含 Token、完整 Deck、未公开底牌或 AI 隐藏 Reasoning 的数据禁止进入指标/日志/告警存储。禁止携带私密牌面。
- **告警关联机制（docs/06 §10.2）**：聚合告警经 `environment`/`version` 标签定位版本与环境；`roomId`/`tournamentId` 的关联**禁止**进入指标标签（per-room 高基数违反 `labelNames` 有限集合红线），改由**结构化应用日志字段** `roomId`/`tournamentId`（与 `version`/`environment` 同条日志）提供可执行关联查询，例如按告警窗口查询 `{app="game-server",level=~"warn|error"} |= roomId=<id>` 的日志行。告警注解只承载脱敏汇总与上述查询指引。
- **演练（monitoring drill，docs/06 §10.2）**：发布前经故障注入触发一次 Game Error/Invariant Violation、重连率、Action Rejection Rate 告警；校验告警内容含版本、环境、room/tournament 关联且不含私密信息；P0 告警需推送/电话即时渠道 + 邮件兜底，P1 发送同一即时渠道。本地演练可用 `infra/monitoring/docker-compose.yml`（Prometheus + Alertmanager + Grafana + webhook-sink）证明「代码产生 → 采集 → Dashboard → 告警」链路；真实即时渠道与 P0 邮件兜底（SMTP/收件人）需授权后配置并重跑演练，未验证送达前不得宣称「监控已完成」。
