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

## 部署、迁移与回滚（TEX-40）

可执行发布运行手册（构建/校验/隔离 smoke/受控迁移/回滚命令与护栏）见 [infra/deployment/README.md](../../infra/deployment/README.md)；本处只记录运维职责与边界，不复制其命令与事实。

- **发布物**：唯一事实源是同一不可变 commit SHA 产出的 Game Server 最小 artifact（`game-server-<sha>.tar.gz` + manifest）。目标机只接收 artifact + 环境注入；不 clone monorepo、不构建 Web、不在目标机 `pnpm install/build`、不对共享环境 `drizzle-kit push`。
- **受控迁移**：迁移由 artifact 自带版本化 migrator 从同一 SHA 执行。**不伪造“数据库自动回滚”**——已执行成功的不可逆/破坏性 schema 变更不能靠盲目 down migration 回滚；此情形只回滚到兼容应用 artifact，或走 TEX-42 经审查的前向修复/恢复。跨部署 DB 锁、schema 语义与恢复策略交接 TEX-42。
- **回滚边界**：release 编排只切二进制、重启并做 post-rollback health；DB schema 保持 expand/contract 兼容前提下可安全回滚。真实故障处置与演练（drain/flush/DB 短暂故障/回滚再部署）在 TEX-43 预发布演练验证。
- **审计与证据**：每次 build/deploy/migrate/start/activate/rollback 生成不含 Secret 的审计记录并关联 artifact SHA/操作者/CI run/时间/结果/失败阶段；Release 证据保留 180 天（docs/06 §10.2/§12.4）。任何含 Token、完整 Deck、未公开底牌或 AI 隐藏 Reasoning 的数据禁止进入日志/审计/产物。
- **待用户/TEX-39 确认的决策项**（TEX-40 不臆造，均以显式参数/占位提供）：云厂商与区域、主机/实例规格、`poker.<domain>`/`api.<domain>` 域名与备案、TLS 证书、systemd 单元与 `SERVICE_NAME`（TEX-41 单实例运行基线）、`DATABASE_URL` 凭据与发布介质（对象存储路径/拉取方式）、告警即时渠道与邮件兜底（SMTP/收件人）、备份/恢复演练窗口与预算。未确认前不得宣称「可上线」。
