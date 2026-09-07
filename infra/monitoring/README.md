# Monitoring

监控、告警与仪表盘定义（TEX-29）。权威阈值与验收见 `docs/06-testing-strategy.md` §10.1/§10.2、§12.4；本目录只提供运行配置并链接引用，不复制阈值形成第二套事实。

## 链路与范围

`game-server /metrics`（Prometheus text）→ Prometheus 抓取 → 告警规则 → Alertmanager → 接收渠道；Dashboard 为 Grafana。告警触发必须覆盖「代码产生 → 采集 → Dashboard → 规则触发 → 通知送达」完整链路，不能只验证埋点函数被调用（docs/06 §10.2）。

## 文件

| 文件 | 职责 |
| --- | --- |
| `prometheus/prometheus.yml` | 抓取 job（game-server）、external_labels（environment/version）、Alertmanager 对接 |
| `prometheus/rules/game-server.yml` | P0/P1 告警规则（阈值对齐 docs/06 §10.2，含最小样本/持续窗口） |
| `alertmanager/alertmanager.yml` | 接收渠道（即时渠道 + 邮件兜底）、路由、抑制、脱敏要求 |
| `grafana/dashboard.json` | 服务端运行面板（活跃数、延迟分位、持久化队列、资源） |
| `docker-compose.yml` | 本地隔离演练栈：prometheus + alertmanager + grafana + webhook 接收器 |
| `scripts/webhook-sink.mjs` | 本地演练用的即时应答接收器（证明本地链路，不代替真实渠道送达） |
| `.env.example` | 渠道令牌/URL 占位（需授权后才填写，不提交真实值） |

## 保留期（docs/06 §10.2）

- 指标 90 天：`docker-compose.yml` 以 `--storage.tsdb.retention.time=90d` 启动参数设置（Prometheus 配置文件不承载 tsdb 保留键）。
- 应用日志 30 天、安全/权限审计与 Release 证据 180 天：Prometheus 不承载日志；由部署环境（Loki/对象存储/CI 产物）在 `docs/05-operations/` 记录并按同一口径配置。任何含 Token、完整 Deck、未公开底牌或 AI 隐藏 Reasoning 的数据禁止进入上述任何存储。

## 告警内容红线

告警必须含：版本（`version`）、环境（`environment`）、适用 room/tournament 关联标识（`roomId`/`tournamentId`，仅脱敏关联字段）。**禁止**携带 Token、完整 Deck、Burn Card 或未公开底牌（docs/06 §7/§10.2）。聚合指标标签不出现 room/player/request 等无限标识；关联信息由日志/告警 annotation 提供。

## 本地演练（隔离，不发生产、不向真实人员发送）

演练前：复制 `.env.example` 为 `.env` 并设置 `GRAFANA_ADMIN_PASSWORD`（Grafana 口令不留仓库）；栈内服务仅绑定 `127.0.0.1`，不向局域网/公网暴露（Greptile 安全项）。

```bash
# 1) 本地监控栈
docker compose -f docker-compose.yml up -d prometheus alertmanager grafana webhook-sink
# 2) 以隔离测试环境启动 game-server（真实 Postgres、load-test 限流档、metrics 端点）
#    详见 tests/performance/README.md「启动被测服务」
# 3) 故障注入触发 Game Error/Invariant、重连率、Action Rejection、Persistence DEGRADED 告警
#    （注入方式与断言见 docs/05-operations/monitoring-drill.md）
# 4) 断言：规则由 PENDING→FIRING、webhook-sink 收到带 version/environment 的告警、Grafana 面板有数
```

本地 webhook-sink 只能证明本地链路，不能代替即时渠道与邮件兜底送达证据；真实通知渠道（PagerDuty/Slack/邮件等）需总负责人授权并在部署环境配置后重新演练。

## 限流 profile 关联

100 Room 级压测使用 `GAME_SERVER_RATE_LIMIT_PROFILE=load-test`（默认关闭、`NODE_ENV=production` 拒绝）。结果报告必须记录该 profile 与 config 版本（docs/06 §10.1 拓扑差异可追溯）。注意：load-test 不放宽认证，不伪造代理头。
