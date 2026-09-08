# P0 任务卡：Web 前端、验证、部署与发布

> 覆盖 Linear TEX-23 至 TEX-30，以及 TEX-39 至 TEX-43。前端只展示服务端权威状态并提交请求，不能自行裁决扑克结果；部署链的实时状态、评论和依赖以 Linear 为准。

## TEX-23：前端基础

- **Linear / 分支**：[TEX-23](https://linear.app/texas-holdem/issue/TEX-23/feattex-23-bootstrap-web-app-and-client-transport) · `feat/TEX-23-bootstrap-web-app-and-client-transport`
- **主责**：Claude Code
- **前置**：TEX-17。
- **要做什么**：建立 Next.js 路由、i18n、客户端状态、HTTP/WS Transport、Snapshot/Event 消费和错误显示。
- **完成标准**：只使用 `src/app` 路由；不自行推导合法动作；缺序时重新同步；不显示 P1 AI/单人入口。
- **权威参考**：`docs/05-frontend-spec.md` §4～§6、§15、§17。

## TEX-24：首页与大厅页面

- **Linear / 分支**：[TEX-24](https://linear.app/texas-holdem/issue/TEX-24/feattex-24-build-home-create-join-and-lobby-flows) · `feat/TEX-24-build-home-create-join-and-lobby-flows`
- **主责**：Trae Work
- **前置**：TEX-19、TEX-23。
- **要做什么**：实现首页、创建/加入、邀请码、房间配置、选座、Ready 与房主操作。
- **完成标准**：权限正确、错误信息清楚、窄屏可用，并支持键盘、可见焦点和语义标签。
- **权威参考**：`docs/05-frontend-spec.md` §6.1～§6.4、§12、§14、§16。

## TEX-25：牌桌与下注页面

- **Linear / 分支**：[TEX-25](https://linear.app/texas-holdem/issue/TEX-25/feattex-25-build-responsive-poker-table-and-betting-controls) · `feat/TEX-25-build-responsive-poker-table-and-betting-controls`
- **主责**：Claude Code
- **前置**：TEX-21、TEX-24。
- **要做什么**：实现 2–10 人响应式 Seat、牌桌、Board、Pot、回合状态和下注控件。
- **关键点**：下注额度完全来自服务端 `LegalActions`；提供 BB/Pot 快捷额、Slider、精确输入与 All-in 二次确认。
- **完成标准**：手机常规下注无需键盘；非当前行动者不可提交；2/3/6/10 人布局和键盘操作合格。
- **权威参考**：`docs/05-frontend-spec.md` §7、§8、§11、§16。

## TEX-26：动画、音效与重连体验

- **Linear / 分支**：[TEX-26](https://linear.app/texas-holdem/issue/TEX-26/feattex-26-build-event-animation-audio-and-reconnect-ux) · `feat/TEX-26-build-event-animation-audio-and-reconnect-ux`
- **主责**：Trae Work
- **前置**：TEX-25。
- **要做什么**：实现 Event → AnimationQueue、发牌/翻牌/下注/Showdown 动画、基础音效和断线体验。
- **完成标准**：Burn Card 不翻开；Showdown 高亮最佳五张；重连不回放旧动画；慢动画不阻塞牌局。
- **权威参考**：`docs/05-frontend-spec.md` §9～§11、§16。

## TEX-27：赛果、设置与个人历史

- **Linear / 分支**：[TEX-27](https://linear.app/texas-holdem/issue/TEX-27/feattex-27-build-results-settings-and-player-hand-history) · `feat/TEX-27-build-results-settings-and-player-hand-history`
- **主责**：Trae Work
- **前置**：TEX-22、TEX-25。
- **要做什么**：实现赛果、再来一局、设置/规则、音效与动态偏好、当前玩家视角的 Hand History。
- **完成标准**：结果与服务端事件一致；历史、缓存和错误页不泄露其他玩家未公开底牌；不实现外部观战或账号战绩。
- **权威参考**：`docs/05-frontend-spec.md` §6.6～§6.7、§13、§17。

## TEX-28：联调 E2E 与安全测试

- **Linear / 分支**：[TEX-28](https://linear.app/texas-holdem/issue/TEX-28/testtex-28-implement-p0-integration-e2e-and-security-tests) · `test/TEX-28-implement-p0-integration-e2e-and-security-tests`
- **主责**：Trae Work
- **前置**：TEX-26、TEX-27。
- **要做什么**：验证完整多人流程、重连、乱序事件、多设备接管、私有信息隔离、无障碍与键盘主流程。
- **完成标准**：失败保留 Trace、截图、视频和 WS 摘要；未处理前端错误或未授权字段均使测试失败。
- **权威参考**：`docs/06-testing-strategy.md` §3.2～§3.4、§6、§7、§9。

## TEX-29：压测、稳定性与监控验证

- **Linear / 分支**：[TEX-29](https://linear.app/texas-holdem/issue/TEX-29/testtex-29-run-load-soak-and-monitoring-validation) · `test/TEX-29-run-load-soak-and-monitoring-validation`
- **主责**：Claude Code（2026-09-05 用户委派，覆盖旧分工 Trae Work）
- **前置**：TEX-22、TEX-28。
- **要做什么**：进行 100 Room/1,000 WS、突发命令、重连风暴、4 小时 Soak 和容量余量测试，并验证告警。
- **完成标准**：达到 P0 SLO 或输出可复现实测偏差；告警与报告绑定候选提交 SHA，且无私密数据。
- **权威参考**：`docs/06-testing-strategy.md` §10～§12。

## TEX-40：发布工件与受控部署流水线

- **Linear / 分支**：[TEX-40](https://linear.app/texas-holdem/issue/TEX-40/tex-40-p0-发布工件与受控部署流水线) · `chore/TEX-40-p0-release-artifact-and-controlled-deployment`
- **主责**：待分派。
- **前置**：无；可与 TEX-41、TEX-42 并行。
- **目录边界**：`.github/workflows/`、`infra/deployment/`、发布脚本/配置、对应 README 与 `docs/05-operations/`；不修改业务逻辑、Nginx、数据库 schema 或观测实现。
- **要做什么**：在同一不可变 SHA 上完成适用 CI 门禁，构建并校验 Game Server 最小运行 artifact；生产机只接收 artifact 与环境注入，不 clone monorepo 或构建 Next.js。设计受控迁移、版本记录、部署前后 smoke、上一 artifact 保留与回滚步骤。
- **完成标准**：干净 checkout 的 CI 可生成 artifact，并以生产命令在隔离环境通过 HTTP/WS smoke；迁移、失败处理、回滚和完整性步骤可执行且可审计；共享环境不使用 `drizzle-kit push`。
- **权威参考**：`CONTRIBUTING.md`、`apps/game-server/README.md`、`docs/05-operations/`、`docs/06-testing-strategy.md` §10～§12。

## TEX-41：反代安全边界与单实例运行基线

- **Linear / 分支**：[TEX-41](https://linear.app/texas-holdem/issue/TEX-41/tex-41-p0-反代安全边界与单实例运行基线) · `feat/TEX-41-proxy-security-and-single-instance-runtime`
- **主责**：待分派。
- **前置**：无；可与 TEX-40、TEX-42 并行。
- **目录边界**：`apps/game-server/src/{app,config,http,realtime}/` 及定向测试、`infra/nginx/`、服务 `.env.example`、对应 README、`docs/04-game-server-architecture.md` 与 `docs/05-operations/`；不修改 artifact、数据库权限或外部告警配置。
- **要做什么**：落实 `HOST=127.0.0.1`、80/443 公开且 3001 不公开的单实例基线；实现可信反代 CIDR、真实客户端 IP 限流、HTTP CORS 与 WS Origin allowlist、连接/Room/Tournament/帧/命令限额和慢连接背压。提供 TLS、HTTP→HTTPS、WS Upgrade、75–90 秒 upstream timeout 与日志配置。
- **完成标准**：经 Nginx 的 HTTPS/WSS、心跳、重连、限流和 Origin 拒绝均通过测试；伪造 forwarded header 不能绕过限制；资源上限由实现执行而非仅留在文档中；liveness/readiness 与反代配置可验证。
- **权威参考**：`docs/02-protocol-spec.md`、`docs/04-game-server-architecture.md` §10、§13、`docs/06-testing-strategy.md` §6、§10～§12。

## TEX-42：Supabase 数据连接、迁移与恢复基线

- **Linear / 分支**：[TEX-42](https://linear.app/texas-holdem/issue/TEX-42/tex-42-p0-supabase-数据连接迁移与恢复基线) · `chore/TEX-42-supabase-connection-migration-and-recovery`
- **主责**：待分派。
- **前置**：无；可与 TEX-40、TEX-41 并行。
- **目录边界**：`apps/game-server/src/infrastructure/persistence/`、持久化恢复适配、定向 integration/recovery 测试、`docs/03-data-model.md`、`docs/05-operations/` 与数据库 README；不修改 Nginx、artifact 或完整性能工具。
- **要做什么**：验证长期服务的 Supabase 连接模式、TLS、连接池、区域 RTT、schema、最小权限和受控迁移；明确 Free/Pro 的暂停、备份和成本边界，并设计恢复演练。验证崩溃恢复、持久化降级和数据库短暂不可用后的数据完整性。
- **完成标准**：预发布连接、迁移、权限、RTT 与恢复记录可复现且不泄露密钥；可从受控恢复点恢复并验证关键牌局数据；数据库故障不得伪造成功、破坏已提交根或绕过背压。
- **权威参考**：`docs/03-data-model.md`、`docs/04-game-server-architecture.md` §12、§13、`apps/game-server/src/infrastructure/persistence/README.md`。

## TEX-43：预发布演练、外部观测与回滚验证

- **Linear / 分支**：[TEX-43](https://linear.app/texas-holdem/issue/TEX-43/tex-43-p0-预发布演练外部观测与回滚验证) · `test/TEX-43-preproduction-observability-and-rollback`
- **主责**：待分派。
- **前置**：TEX-40、TEX-41、TEX-42；以及可证明当前候选 SHA 的 TEX-29 容量/告警证据。
- **目录边界**：`infra/deployment/` 的预发布配置和演练资产、`docs/05-operations/`、外部/云监控说明、预发布 smoke/恢复/回滚证据；不重写安全边界、数据库 schema、artifact 或 TEX-29 负载工具。
- **要做什么**：在与目标拓扑等价的预发布环境验证 DNS/TLS、环境注入、systemd `Restart=on-failure` 与 `TimeoutStopSec ≥ 150s`、HTTP/WS/写库/重连 smoke、真实指标采集和告警送达。演练失败重启、DB 短暂故障、drain/flush、artifact 回滚和恢复后的再部署。
- **完成标准**：同 SHA 的部署、健康/就绪、连接、写库、告警、恢复与回滚记录完整；监控采集真实指标且报告不含 Token、完整 Deck 或未公开底牌；所有区域、备案、域名、套餐和预算决策均列明。
- **权威参考**：`docs/05-operations/`、`docs/06-testing-strategy.md` §10～§12、`docs/04-game-server-architecture.md` §12、§13。

## TEX-39：部署拓扑与预发布基线

- **Linear / 分支**：[TEX-39](https://linear.app/texas-holdem/issue/TEX-39/tex-39-p0-部署拓扑与预发布基线) · `chore/TEX-39-p0-deployment-topology-and-preproduction-baseline`
- **主责**：Codex（拓扑集成/验收）和用户（外部资源与成本决策）。
- **前置**：TEX-40、TEX-41、TEX-42、TEX-43。
- **要做什么**：集成并审阅以下固定 P0 拓扑及所有子任务证据：`poker.<domain>` 的 Vercel Web，`api.<domain>` 的 Nginx→单实例 Game Server，以及 Supabase PostgreSQL。首版不部署 Redis，不支持水平扩容，2C2G 只是待验证候选。
- **完成标准**：端口、DNS/TLS、Secret、单实例边界、数据库、备份恢复、观测、回滚和发布窗口无冲突；实际配置与 README、权威规格和候选 SHA 一致；用户已确认或显式阻塞云厂商、区域、域名、备案/合规、套餐、备份与预算。
- **输出**：向 TEX-30 交付拓扑版本、部署配置 SHA、预发布验证、回滚演练和外部服务决策记录。
- **权威参考**：`docs/04-game-server-architecture.md` §10、§12、§13、`docs/05-operations/`、`docs/06-testing-strategy.md` §10～§12。

## TEX-30：发布证据包与最终验收

- **Linear / 分支**：[TEX-30](https://linear.app/texas-holdem/issue/TEX-30/tex-30-p0-发布证据包与最终验收) · `chore/TEX-30-p0-release-evidence-and-acceptance`
- **主责**：Codex（规格一致性、风险结论）和用户（实机验收、外部决定与最终发布）。
- **前置**：TEX-29、TEX-39，以及所有与候选 SHA 相关的 P0 实现/安全缺陷任务。
- **要做什么**：汇总同一不可变候选 SHA 的 CI、lockfile、artifact、迁移、预发布部署、HTTP/WS/写库/重连 smoke、备份恢复、回滚、容量/Soak/告警、真实设备与缺陷证据。检查候选是否按已批准的 Vercel + Nginx/单实例 Game Server + Supabase 拓扑运行。
- **完成标准**：TEX-39 子任务全部通过；100 Room/1,000 WS 的 SLO 与 130/1,300 安全余量具备同 SHA 的目标机证据；无未处置 P0/P1 缺陷、隐藏信息泄露、不可恢复持久化故障或未送达 P0 告警。任何候选代码、锁文件、部署/数据库/外部服务配置变更都必须重跑受影响证据。
- **输出**：Release Candidate 证据索引、P0/P1 缺陷和剩余风险、成本/容量结论、Codex 的 Go/Conditional Go/No-Go 建议及用户最终决定。
- **权威参考**：《德州扑克项目总规划》§9、`docs/04-game-server-architecture.md` §10、§13、`docs/05-operations/`、`docs/06-testing-strategy.md` §9～§12。
