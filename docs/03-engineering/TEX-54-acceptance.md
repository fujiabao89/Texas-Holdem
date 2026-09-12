# TEX-54 持久化赛果读取验收

日期：2026-09-12。分支：`feat/TEX-54-persisted-tournament-result`。本卡交付只读服务端端点与共享协议；不包含前端刷新接入或修改既有终局写入模型。决策先于实现记录于 [ADR-0004](../adr/0004-tex-54-persisted-tournament-result.md)，权威契约在 02/03/04/06 的 TEX-54 小节。

## 交付与验收

- 新增 `GET /api/v1/tournaments/{tournamentId}/result`。UUID/无查询参数/成功信封全部来自共享 strict Schema，错误使用 ErrorEnvelope；既有 WebSocket 主版本由共享 `PROTOCOL_VERSION` / 02 §4.1 决定，本 HTTP 增量不升级它。
- PostgreSQL REPEATABLE READ / READ ONLY 事务内授权所属未关闭 Room 的 ACTIVE HUMAN 成员，允许同 Room 非参赛成员读取公开赛果。失效/错误 Room/已离开/关闭/撤销凭证均拒绝，Token 不从 URL 取值。
- 仅持久化 FINISHED 且终局 Snapshot/事件标记/Participant/冠军/最终筹码/排名相互一致返回；并列范围来自 `finalStandings`，唯一 rank 仅作展示序一致性校验。真实正常终局、同手并列、手内主动退出与无冠军终局均经过 Executor → 未改造的生产 Commit Bundle → 真实 PostgreSQL → HTTP 验证。
- 新建 HTTP app 使用空 RoomManager 且不提供 TournamentManager；关闭重建 app 后仍读得相同公开结果，同 Room 下一场 IN_GAME 不覆盖前场赛果。Drizzle 对生产 JSON 文本快照的解码对象与 checksum 通过真实链路验证。
- 全部返回 no-store，含全局限流提前拒绝；到 `retention_expires_at` 即404，清理延迟不会延长访问，读取不会续期。无新增数据库迁移、环境变量或清理任务。
- 白名单响应排除 Deck/Burn/底牌/内部参赛ID/Time Bank/Token/原始事件；私密快照哨兵与真实内部ID不出响应。失败不记录原始异常，安全500不影响健康端点；现有HTTP指标不含身份标签。

## 验证证据

在本机隔离 PostgreSQL（loopback、合成测试数据、每套件独立schema）运行，没有跳过数据库验证。

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 4个包全部通过，含Next生产构建 |
| `pnpm typecheck` | 全部包与测试TypeScript通过 |
| `pnpm lint` | 通过；现有 `tests/ws/gateway-protocol.test.ts:61` 未使用变量警告1条，无新增警告 |
| `pnpm test:unit` | 77文件，719测试通过 |
| `TEX_TEST_DATABASE_URL=<隔离测试库> pnpm test:integration` | 9文件，83测试通过，含本卡19个真实PG用例 |
| `pnpm test:ws` | 2文件，11测试通过 |
| `pnpm exec vitest run --project unit packages/protocol/src/tournament-result.test.ts apps/game-server/src/http/routes/tournament-result.test.ts` | 新增协议与故障隐私22测试通过 |
| `git diff --check` | 通过 |

新PG套件由独立Agent再次只读执行，19/19通过；核心仓储/投影/授权与限流no-store审阅未留新增可操作缺陷。既有工具告警：Vite CommonJS配置的未来默认行为提示、pg连接初始化的未来弃用提示；不影响本轮结果。

主 Agent 已将 TEX-53 与 TEX-54 合并到独立验证工作区（验证提交 `73c69ba`），仅处理文档追加冲突，生产代码自动合并。联合 `pnpm build`、`pnpm typecheck`、`pnpm lint` 通过；配置本机隔离 PostgreSQL 执行 `pnpm test`，93 个文件、864 项测试全部通过，无数据库跳过。40 份变更 Markdown 的 410 个本地链接与 diff whitespace 检查通过。TEX-53 的受影响浏览器回归为 26 通过、1 项在干净主分支同环境复现的既有失败，不作为本端点的浏览器接入验收。

本地实现与联合验收已交付。GitHub 登录已恢复，分支已推送至 `sizhehao6-glitch/Texas-Holdem`，上游 [PR #48](https://github.com/fujiabao89/Texas-Holdem/pull/48) 已创建，待审阅与合并；最新交付状态在对应 Linear 任务跟踪。

## 已知既有问题与非范围

1. **已提交手末暂停后，手间退出触发终局未持久化。** 复现：`START → PAUSE_AFTER_HAND(true) → 两人首手FOLD → 手间一人WITHDRAW`。Engine/Runtime变FINISHED，但 `handNumber == committedThroughHand == 1`，既有 `TournamentExecutor.advance()` 不再提交该手；只产生1个不含finish的Bundle，后续 `PLAYER_WITHDRAWN` / `TOURNAMENT_FINISHED` 未落库，数据库仍IN_GAME，本端点按事实返回409 `TOURNAMENT_NOT_FINISHED`。背压暂停/关停/恢复手间窗口可能触发；需要独立设计符合append-only约束的手间终局提交，不能篡改旧手或伪造新手。本卡不声称所有终局写入场景已覆盖。
2. **旧live投影在手内退出终局时可能显示撤回前筹码。** 两人手内P0 WITHDRAW后，Engine Participant与DB最终筹码为0，forfeitedChips可为990，但旧 `state-projector.ts` 优先读取最后一手seat，可能显示990。本端点坚持Participant/DB最终0，不沿用旧live差异；普通冠军/并列排名与live投影一致，撤回筹码对齐权威Participant。旧live投影修复属于后续事项。
3. 前端赛果页面的HTTP刷新/重连恢复接入仍属独立后续任务；当前交付端点本身可在新连接/Runtime卸载后读取。没有执行前端E2E（未修改页面行为，仅补新错误码中文映射）。
4. 本端点按支持的Snapshot/Engine版本严格拒绝不兼容历史数据；不做旧格式迁移或猜测修复。保留期清理Job没有在本卡新增。

## 文档同步检查

涉及的服务端/HTTP/投影/持久化/仓储/测试README、协议包与Schema/错误README、Web文案README均已更新；02/03/04/06权威规格、ADR/架构索引、任务执行索引、工程验收索引、安全与运维说明均已同步。

已检查，无需更新：01引擎规则、05前端页面规格（本卡不改变扑克规则或页面流程）；持久化schema/migrations与Writer/Runtime README（本卡无表结构或写入职责改动，已知旧边界在本验收记录明确）；生产环境变量模板与部署配置（无新增配置）；纯规则测试与前端E2E（无规则/UI行为改动）。新增Markdown相对链接已检查有效，文档未复制并列裁决规则。无外部PR审查评论修改，因此本轮无原始评论线程闭环事项；DeepSeek Harness/Greptile未启动。
