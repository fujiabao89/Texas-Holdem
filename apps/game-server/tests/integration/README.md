# Integration tests

验证数据库、实时网关及服务端模块之间的集成行为。

入口：`pnpm test:integration`（根 vitest 配置的 `integration` project）。涉及真实数据库的用例使用 [tests/support/test-db.ts](../../../../tests/support/test-db.ts)：每次运行唯一 `runId` + 独立 schema，缺配置时整组受控跳过；不依赖真实密钥或第三方网络（docs/06-testing-strategy.md §2.1）。

## 用例（TEX-18）

| 文件 | 覆盖 |
| --- | --- |
| `migrations.test.ts` | 空库迁移一次成功（表/枚举/DEFERRABLE FK/部分唯一索引）；迁移幂等 |
| `control-plane.test.ts` | Room+Host、Tournament+Players 单事务原子性与失败回滚；昵称唯一 |
| `hand-commit-bundle.test.ts` | Commit Bundle：事件顺序与 Snapshot/水位线对齐、失败整体回滚、相同 checksum 幂等重试、不同内容/部分冲突安全失败、终局同事务更新 |
| `constraints.test.ts` | 复合 FK（跨 Room/跨 Tournament）、CHECK（枚举-null 矛盾等）、seat/player/rank 唯一、盲注与公共牌边界 |
| `room-recovery.test.ts`（TEX-51） | 非 CLOSED Room 与 ACTIVE 身份读取、LEFT 凭证排除、BOT 无凭证、历史最大场号与锁定座位、控制面与终局 Bundle 延迟状态、坏配置原样交给逐房隔离、并发提交下的 REPEATABLE READ / READ ONLY 一致快照；revision 号段顺序/并发预留、耗尽/关闭拒绝与迁移边界约束 |
| `permissions.test.ts` | `anon`/`authenticated` 对所有原始表读写被拒；`game_server` 角色最小授权可用 |
| `hand-history-read.test.ts`（TEX-36） | Hand History 投影读取端点：token 摘要数据库侧鉴权（401/403/404，含 Room CLOSED / 成员 LEFT）、倒序 cursor 分页（默认 20/上限 50/重复参数 400）、双身份投影隔离、跨 Tournament 404、事件首/中/尾缺失与双序列损坏 500；真实 TournamentExecutor → Commit Bundle → PostgreSQL → HTTP 验证手间撤回归属、有效淘汰观战者读取无冠军终局 |
| `room-restart.test.ts`（TEX-51） | 真实生产 `main.ts` 子进程经 `SIGKILL` 重启，同一 PostgreSQL schema / HMAC 配置：Lobby 邀请码、Host 与原令牌恢复、未持久化的 seat/ready/presence 安全重置；跨重启 roomRevision 增长且旧 HTTP revision 拒绝；真实双客户端首手提交 → 重启 → 原令牌重连 → 下一手提交；筹码与已提交快照对齐、后续序列连续、私牌隔离；无有效 Host 房间隔离与跨房凭证拒绝 |
| `terminal-history.test.ts`（TEX-52） | 真实 Room/Tournament/Writer → PostgreSQL → HTTP：正常终局后 Fake Clock 推进 10 分钟卸载 Runtime，两个原 token 仍可读取已提交列表/详情；未摊牌的对手底牌与 Burn 牌面保持隔离；LEFT 成员及 CLOSED 房间的旧 token 对两个历史端点均失效 |

公共基建设施见 [helpers.ts](./helpers.ts)：`setupIntegrationDatabase`（CREATE SCHEMA → 在隔离 schema 执行版本化迁移 → 交给仓储层 → 结束 DROP SCHEMA CASCADE）。

## 运行（本地 PostgreSQL 容器示例）

```bash
docker run -d --name tex18-test-postgres -e POSTGRES_PASSWORD=tex18test -p 55432:5432 postgres:16-alpine
TEX_TEST_DATABASE_URL=postgres://postgres:tex18test@localhost:55432/postgres pnpm test:integration
```

需要超级用户或等价权限（迁移创建 `anon`/`authenticated`/`game_server` 角色并做 GRANT/REVOKE）。CI 中未配置测试库时本层受控跳过（TEX-12 基线）。

TEX-54：`tournament-result-read.test.ts` 从真实 Executor 生成未经改造的生产 Bundle，覆盖冠军/并列、手内主动退出、无冠军、同 Room 非参赛成员与多场隔离、无 Runtime 的新 app、失效授权/到期、11 类损坏、投影隐私和限流 no-store。运行：`TEX_TEST_DATABASE_URL=<隔离测试库> pnpm exec vitest run --project integration apps/game-server/tests/integration/tournament-result-read.test.ts`。已知手间写入缺口见 [验收记录](../../../../docs/03-engineering/TEX-54-acceptance.md)。

仅运行实际进程重启验收：

```bash
TEX_TEST_DATABASE_URL=postgres://postgres:tex18test@localhost:55432/postgres pnpm exec vitest run --project integration apps/game-server/tests/integration/room-restart.test.ts
```

重启测试由父测试进程迁移一次独立 schema，子进程直接执行生产入口；不能用会重建 schema 的 E2E/Performance launcher 代替。监听端口由系统分配，子进程只绑定 loopback；每个用例结束先停止其子进程并关闭 WebSocket，再清理自己的 schema。等待监听日志、真实帧或 PostgreSQL 已提交水位，有明确超时，不通过任意 sleep 推进被测业务。序列恢复锚定已提交水位，允许丢弃崩溃时尚未提交的一手；不会把旧进程最后一条实时事件当作持久化承诺。
