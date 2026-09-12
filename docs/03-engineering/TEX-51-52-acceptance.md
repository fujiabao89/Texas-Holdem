# TEX-51 / TEX-52 验收记录

验证日期：2026-09-12。用户明确委派 Codex 实施两项任务；本记录只保存验收证据，不替代权威规格。代码交付等待负责人审查合并，不代表已部署。

## 范围与权威来源

- TEX-51：Room、ACTIVE 成员、Host、原身份摘要与邀请码先于 Tournament 恢复；数据校验隔离、基础设施故障拒绝启动、持久 revision 号段防止重启后的旧命令通过。决策见 [ADR-0003](../adr/0003-tex-51-room-recovery-authority.md)，数据契约见 [03](../03-data-model.md)，恢复部署见 [运行手册](../05-operations/room-recovery.md)。
- TEX-52：终局只读保留后卸载、CLOSED Room 重型状态释放与轻量墓碑、Timer/连接/Writer/幂等缓存生命周期、活跃指标校准。契约见 [04 §13.2](../04-game-server-architecture.md)，测试门槛见 [06](../06-testing-strategy.md)。
- 未修改扑克规则、公开协议 Schema、页面视觉、账号体系或模拟筹码范围。原工作目录中用户未提交的前端样式保留不动。

## 可重复验证

先准备隔离 PostgreSQL 16 测试库并设置 `TEX_TEST_DATABASE_URL`。测试会创建/销毁独立 schema，真实重启测试会启动/终止测试子进程，禁止指向生产库。缺少数据库配置导致跳过不算通过。

```bash
pnpm typecheck
pnpm --filter @texas-holdem/game-server lint
pnpm --filter @texas-holdem/game-server build
pnpm exec vitest run --project unit --project rules --project integration --project ws
git diff --check
```

2026-09-12 本地验证使用真实 PostgreSQL 16.14。全仓类型检查与服务端构建通过；服务端 lint 无错误，保留既有 `tests/ws/gateway-protocol.test.ts` 的一个未使用变量警告。完整 unit / rules / integration / ws 回归 **97 个文件、922 项测试通过**，无数据库跳过；本次变更的 TypeScript/JSON 已通过 Prettier 格式检查。

| 验收项 | 证据入口与结果 |
| --- | --- |
| 原身份重连并继续下一手 | `apps/game-server/tests/integration/room-restart.test.ts` 的 3 个真实生产入口子进程用例通过：SIGKILL → 同库重启 → 原 token 双客户端重连 → 下一手提交；同时验证私牌、序列、筹码、Host、邀请码及 revision 屏障 |
| 损坏与恢复失败边界 | `persistence/recovery.test.ts`、`persistence/room-recovery.test.ts`：版本/checksum/事件缺口、跨字段冲突、未知身份 key、重复恢复等受控隔离；意外仓储 I/O 故障中止启动而非静默开服 |
| 持久化恢复读取 | `tests/integration/room-recovery.test.ts`：真实一致性读取、LEFT/CLOSED 凭证排除、历史最大场号、revision 并发预留与安全整数上界 |
| 多轮生命周期收敛 | `rooms/runtime-lifecycle.test.ts`：24 Room × 3 轮 = 72 Tournament，多批完赛/复玩/关闭后推进 Fake Clock，全部注册对象、队列、epoch、计时器计数回到 0 |
| Writer 与旧场隔离 | `tournaments/tournament-lifecycle.test.ts`、`persistence/persistence-writer.test.ts`：包含 100 轮 Manager/Writer 重试回收、Bundle 独立副本、终局幂等重放、旧输出/清理不影响新场 |
| 退出及关闭竞争 | `rooms/room-lifecycle-races.test.ts`、`rooms/leave-coordinator.test.ts`、HTTP/WS 测试：末位真人退出先触发关房时仍返回权威最终 Snapshot；最后成功响应不被提前断连吞掉；单订阅者/连接发送失败不阻塞其他解绑；错误缺房不伪装成退出成功 |
| 卸载后的历史与鉴权 | `tests/integration/terminal-history.test.ts`：真实 PostgreSQL + Room/Tournament/Writer + HTTP，10 分钟卸载后原凭证仍读持久投影；对手未公开底牌/Burn 牌面不泄露；LEFT/CLOSED 凭证返回 401 |

以上短文件路径相对 `apps/game-server/src`，明确写出 `tests/integration` 的路径相对 `apps/game-server`。

## 有界 soak 观测

同一确定性运行的三个批次观测如下；Heap/RSS 是诊断采样，不以偶然 GC 或绝对字节值作为门禁。每批清理后重型对象、墓碑、Writer 队列、epoch 与业务计时器都为 0，累计实际提交 75 个 Bundle。

| 批次 | Heap used（bytes） | RSS（bytes） | 累计提交数 |
| --- | ---: | ---: | ---: |
| 1 | 33,294,640 | 117,784,576 | 26 |
| 2 | 33,698,776 | 118,013,952 | 51 |
| 3 | 32,019,128 | 118,931,456 | 75 |

这是有界生命周期回归，不等同于 4 小时真实流量容量/发布 soak；正式长跑仍按 [06 §10](../06-testing-strategy.md) 和 [性能工具](../../tests/performance/README.md) 在隔离发布环境完成。

## 发布约束与未覆盖边界

- 上线前执行 `0003_room_revision_reservation` 迁移，保持原 `TOKEN_HMAC_SECRET` / `TOKEN_HMAC_KEY_ID`，只允许单一 game-server 写者；本任务不执行生产迁移或部署。
- 只恢复已完整提交手末。已离开成员在最近检查点仍为 ACTIVE 的提交时间差采用保守整房隔离，不能宣称所有崩溃点均无损恢复；处置见恢复手册。
- 数据库历史 TTL 清理、HMAC key 轮换、多写者协调、正式长时容量测试不在本次交付内。
- 本次未改前端，未追加浏览器视觉/实机测试。未自动启动 Greptile 或 DeepSeek Harness 审查。

## 文档同步检查

- 已更新：受影响服务端目录 README、迁移与仓储说明、03 数据模型、04 服务端架构、06 测试策略、ADR 索引、身份/投影安全与恢复运维说明、工程总索引及本验收记录。
- 项目任务卡：验收与交付链接回填 Linear TEX-51 / TEX-52；不在其他规划文档复制任务事实。
- 已检查，无需更新：01 扑克规则、02 公开协议 Schema、05 前端规格、产品目标与筹码范围，因为本次不改变这些契约；生产发布流水线及监控配置只消费既有指标端点，没有新的必需环境变量或抓取目标。
