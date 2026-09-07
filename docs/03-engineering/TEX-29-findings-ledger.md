# TEX-29 Findings Ledger

PR #39 审查意见核验与处置台账（2026-09-05）。来源：Codex（chatgpt-codex-connector）、Greptile（greptile-apps）、CodeRabbit（coderabbitai）。每一条均已对照分支当前代码核验；处置含「已修复 / 跳过（附理由）/ 后续（Release/隔离环境阶段）」。范围纪律：只修复确认应阻塞本 PR 的问题，不做无关重构。

| # | 来源 | 位置 | 意见（压缩） | 核验结论 | 严重度 | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Codex/C-R/Greptile | tests/performance burst | burst 未按 `opWindowMs` 调度，可能假通过 | 确认 | P1 | 已实现：非缩减 burst 以 `target.opWindowMs` 为窗口执行，`APPLIED`<`opCount` 判 insufficient；窗口判定逻辑由 `driver-window.test.ts` 确定性覆盖（真实 Release 压测待隔离环境） |
| 2 | Codex/CodeRabbit | driver.ts | `deadline` 在建桌前计算，ramp 计入窗口 | 确认 | P1 | 已修复：`runSustained` 建桌完成后再起算窗口 |
| 3 | Codex/CodeRabbit/Greptile | soak 内存 | Soak `memoryGrowthRatio` 恒 null（未采集 RSS），门禁不可判 | 确认 | P1 | 已实现：soak 经被测 `/metrics` 每 10s 采样 RSS，≥2h 时按首/末 1h 窗口算 `growthRatio` 写入 metrics；不足窗口保持 `not-measured`；`soakRatioOrNull` 确定性用例覆盖 >1.1/时长不足/样本不足 |
| 4 | Codex/CodeRabbit/Greptile | unexpected disconnect | driver 本地意外断连计数恒 0，normal 门禁空转 | 确认（局限） | P1 | 跳过：Release 权威判定用被测 `/metrics` 的 `texas_ws_connections_closed_total{category}`（服务端类别），本地 driver 不做伪计数 |
| 5 | Codex | driver.ts | WS schema 违反未计入失败 | 确认 | P1 | 已修复：`countSchemaViolations` 计入 `invariantViolations`（sustained 与 reconnect 收尾均调用） |
| 6 | Codex/CodeRabbit | main.ts CPU | `process.cpuUsage(lastCpuUsage)` 增量写回基线导致比值错 | 确认 | P2 | 已修复：用两次绝对快照作差 |
| 7 | Codex | Grafana 未自动 provisioning | compose 仅挂数据卷，dashboard/datasource 未自动导入 | 确认（运维增强） | P2 | 跳过/后续：本地演练可手动导入或后续补 `grafana/provisioning`；不阻塞本 PR |
| 8 | Greptile | performance.yml | 正式负载用共享 runner | 确认（流程约束） | P1 | 已加 workflow guard：正式 normal/burst/soak/headroom 必须显式提供候选 `inputs.sha`，禁止 ref 兜底；runner 隔离仍属 Release 流程约束（README 已述） |
| 9 | Greptile | compose/webhook 暴露 | 端口/容器以 root、日志打印 | 确认（部分） | P1 | 已修复：compose 四服务绑定 `127.0.0.1`；Dockerfile `USER node`；sink 仅 POST + 1MiB 上限/413 + 请求/头超时；日志仅脱敏告警字段（#20/#21） |
| 20 | Greptile | docker-compose Grafana | 仓库已知 admin 口令 + `0.0.0.0:3000` 暴露 | 确认 | P1 | 已修复：绑定 `127.0.0.1:3000`；口令改 `.env` 必填（`GRAFANA_ADMIN_PASSWORD`，.env.example/README） |
| 21 | Greptile | scripts/webhook-sink.mjs | 请求体无界、无超时 + `0.0.0.0:9000` 暴露 | 确认 | P1 | 已修复：仅 POST、1 MiB 体积上限/413、`requestTimeout/headersTimeout`、绑定 `127.0.0.1:9000` |
| 10 | CodeRabbit | prometheus retention | 配置文件含无效 `storage.tsdb.retention.*` | 确认 | P1 | 已修复：移除配置块，保留 docker-compose CLI 标志 `--storage.tsdb.retention.time=90d` |
| 11 | CodeRabbit | rules/game-server.yml | Action 拒绝率含预期/用户输入码掩盖服务端回归 | 确认 | P1 | 已修复：表达式排除 `NOT_YOUR_TURN/STALE_GAME_STATE/ACTION_TIMEOUT/SESSION_REPLACED/INVALID_ACTION/INVALID_AMOUNT/TOURNAMENT_NOT_ACTIVE` |
| 12 | CodeRabbit | engine 基址 | 远端明文 http / ws 发送 token | 确认 | P1 | 已修复：`normalizeServerBase`/`serverInfoFrom` 仅 loopback 允许 http→ws，远端强制 https→wss |
| 13 | CodeRabbit | redaction | `BEARER_PATTERN` 无 `g`，多 Token 只替换首个 | 确认 | P3 | 已修复：替换用全局正则，检测保留非全局；补测试 |
| 14 | CodeRabbit | run.ts | `meta.runId` 与隔离 schema runId 不一致 | 确认 | P2 | 已修复：`LocalHandle` 携带 runId，本地运行产物复用；外部 `--base-url` 才新建 |
| 15 | CodeRabbit | run.ts | `--keep-server` 声明但未生效 | 确认 | P1 | 已修复：finally 按 `args.keepServer` 决定是否 kill/drop |
| 16 | CodeRabbit | docs/00-project | p0-task-overview 状态“尚未开始”过时 | 确认 | P3 | 已修复：改为“实现进行中…正式负载/人工验收待 Release” |
| 17 | CodeRabbit | docs/README | blockquote 空行 MD028 | 确认（风格） | P3 | 跳过：非 CI 门禁、纯 markdownlint 风格，后续统一 prettier/markdown 处理 |
| 18 | CodeRabbit | docs/05 ops 告警关联 room/tournament | 聚合告警缺 room/tournament 关联 | 确认 | P1/P2 | 已修复：docs/06 §10.2 与 docs/05-operations 明确——聚合告警带 `environment`/`version` 标签，`roomId`/`tournamentId` 关联经结构化日志字段（附查询指引），明确禁用 per-room 高基数指标标签 |
| 19 | CodeRabbit | scenarios.test | 需要 opWindowMs 运行器级时间窗测试 | 同 #1 | P1 | 同 #1：burst/reconnect 窗口判定已落地并配 `driver-window.test.ts` 确定性边界测试（窗口内完成/超窗未完成） |

**验证**（修复后）：`pnpm exec vitest run --project unit` = 619 通过；`tsc --noEmit -p tsconfig.test.json` = 0 错；eslint 相关文件 = 0 错。真实链路正式负载仍未在共享/本地运行（需隔离环境），与 docs/06 §10 诚实性约定一致。
