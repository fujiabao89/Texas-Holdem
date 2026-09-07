# Performance tests（真实链路压测）

容量、延迟与稳定性验证（TEX-29 已落地）。与 `tests/simulator`（纯引擎、无网络）互补：本目录**只走真实链路**——HTTP（create/join/PATCH/start）+ WS（AUTH/SET_READY/SUBMIT_ACTION）+ 真实 `apps/game-server`（权威投影/序列化/持久化 Writer）+ 真实 PostgreSQL，不允许 in-memory / harness 替代（docs/06-testing-strategy.md §10）。

权威规格：[docs/06-testing-strategy.md](../../docs/06-testing-strategy.md) §10.1（场景负载与 Release 门槛）、§10.2（监控）、§11（CI 分层）。

## 入口

```bash
pnpm test:perf -- --scenario smoke [--sha <hex>]            # 真实链路功能冒烟（不判 SLO；PR/本地）
pnpm test:perf -- --scenario normal --sha <hex>             # 正式：100 Room × 10 WS × 30min
pnpm test:perf -- --scenario burst --sha <hex>              # 正式：500 命令/1s 分 ≥50 Room
pnpm test:perf -- --scenario reconnect --sha <hex>          # 正式：500 重连/1min
pnpm test:perf -- --scenario soak --sha <hex>               # 正式：50 × 10 × 4h
pnpm test:perf -- --scenario headroom --sha <hex>           # 正式：130 × 10 × 10min
```

- 场景默认负载 = docs/06 §10.1 表；参数 `--rooms/--players/--duration-ms` 可覆盖，**下调即缩减运行**（`reducedEvidence=true`，产物如实标注，退出码 3，不作为 Release 证据）。
- `--sha` 绑定产物与门禁；正式场景必填，可经 `TEX_PERF_SHA` / `GITHUB_SHA` 提供。
- 本地拉起：需要真实 PostgreSQL（`TEX_TEST_DATABASE_URL` 或 `DATABASE_URL`），并先 `pnpm build`（生成 protocol/poker-engine dist）。启动器在隔离 schema `tex_perf_<runId>` 上迁移 + 生产入口启动 game-server，结束后自动 DROP（`--keep-server` 保留）。接入已运行隔离实例用 `--base-url <url>`（跳过拉起）。
- 被测实例必须启用压测档限流：本地拉起自动注入 `GAME_SERVER_RATE_LIMIT_PROFILE=load-test`；外部接入请自行确认。

## 场景与门禁

| 场景 | 默认负载 | Release 门槛（§10.1） | 判定 |
| --- | --- | --- | --- |
| smoke | 2 × 4 WS × 90s | 无 SLO（验证链路功能不变量） | 功能不变量：无 schema 违反 / sequence 断点 / 非竞态拒绝 / 崩溃，且有动作样本 |
| normal | 100 × 10 × 30min | Action→Event p95 ≤250ms、p99 ≤500ms；业务 5xx <0.1%；意外断连 <0.1%；Invariant = 0 | `pnpm test:perf` 对产物与门禁做统一判定（样本不足/缩减运行 ≠ 通过） |
| burst | 50 Room、500 命令/1s | p99 ≤1s；同桌 sequence/幂等/投影断言全过 | 同上 |
| reconnect | 50 × 10、500 重连/1min | 认证至首个完整 Snapshot p95 ≤1s、p99 ≤2s；恢复错误率 <0.1% | 同上 |
| soak | 50 × 10 × 4h | 崩溃/死锁/Invariant = 0；末小时内存均值 ≤ 稳态小时 1.1 倍 | 同上 |
| headroom | 130 × 10 × 10min | 不崩溃/不 OOM/Invariant = 0/无跨桌污染 | 同上 |

裁决区分 `pass / fail / insufficient-sample / not-measured`：样本不足与未测量**不等于通过**（docs/06 §10.1）。延迟为 driver 观测值（含本机回环 RTT）；Release 判据建议同时读取被测实例 `/metrics` 的服务端直方图（`texas_action_to_event_seconds`、`texas_reconnect_recovery_seconds`）。

## 正式运行的边界（诚实性约定）

- **PR CI 只跑 smoke**（`.github/workflows/ci.yml` 的 `perf-smoke` job，真实 PostgreSQL service 容器）。
- **Nightly 只跑 reconnect**（`.github/workflows/performance.yml` schedule，每日 18:48 UTC）。
- **normal/burst/soak/headroom 只能在隔离测试环境由 Release/受权维护者 `workflow_dispatch` 触发**，绑定固定候选提交；共享 Runner 结果不足以作为 Release 门槛（docs/06 §10：不得以"机器较慢"为由降低目标，正式数字须在隔离环境复测）。
- 本机无 Docker/PostgreSQL 时无法本地跑真实链路 smoke；此时以 PR CI `perf-smoke` 的真实链路结果为链路证据，本地验证收敛到 `pnpm test:unit`（本目录纯模块自测）+ `tsc --noEmit -p tsconfig.test.json` + eslint。

## 产物与脱敏

产物写入 `tests/performance/.artifacts/perf-<scenario>-<ts>.json`（默认；`--out` 可改）：`meta`（scenario/sha/runId/机器规格/reducedEvidence/note）、`load`（实际 rooms/players/duration/opTarget）、`metrics`（计数 + 延迟摘要 + 比率）、`gates`（逐项 SLO 判定与 verdict）。写盘前经 `redaction.ts` 递归脱敏并由 `sensitiveKeysIn` 断言：**Token/Deck/Burn/未公开底牌/隐藏 Reasoning 永不进入产物**（docs/06 §10.2 红线）。playerToken 只在 driver 内存，从不落盘。

退出码：`0` 通过；`1` 失败；`2` 参数/环境错误；`3` 证据不足/缩减运行（不折算为通过）。

## 目录

| 文件 | 职责 |
| --- | --- |
| [run.ts](./run.ts) | CLI 入口：拉起/接入隔离实例、执行场景、汇总、门禁、脱敏产物与退出码 |
| [cli.ts](./cli.ts) / [scenarios.ts](./scenarios.ts) | 参数解析；场景目标（§10.1 默认负载）与 SLO 阈值表（含缩减判定） |
| [engine.ts](./engine.ts) | HTTP/WS 原语：建房/join/换座/开赛命令、合法动作选择、单次重连测量 |
| [driver.ts](./driver.ts) | 场景驱动：开桌→代理持续打牌（终局自动「再来一局」）；重连风暴分发 |
| [launch-game-server.ts](./launch-game-server.ts) | 隔离 schema `tex_perf_<runId>` 迁移 + 生产入口启动被测实例 |
| [stats.ts](./stats.ts) / [gates.ts](./gates.ts) / [metrics.ts](./metrics.ts) | 百分位/窗口统计原语；门禁裁决；采样收集（PerfMetrics） |
| [redaction.ts](./redaction.ts) | 产物敏感键防御性过滤与写盘前扫描 |
| 各 `*.test.ts` | 纯模块自测（归 unit 层，`pnpm test:unit`） |

## 协议锚点（实现引用）

消息形状以 `packages/protocol` Schema 为准（`commands`/`events`/`schemas/views`）。关键事实：开赛是 Host 仅有的 `POST /rooms/{id}/tournaments`（乐观锁 `expectedRoomRevision`）；换座/就绪分别经 PATCH 与 WS `SET_READY`；`SUBMIT_ACTION` 需 `expectedSequence` 等于当前 `lastWireSequence` 且仅当前 actor 有权行动；终局后 Host 对 `FINISHED` 房间再开一场即「再来一局」续压。合法动作一律取服务端 `legalActions` 并选 min 值，避免 `INVALID_AMOUNT`。
