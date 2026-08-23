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
| `permissions.test.ts` | `anon`/`authenticated` 对所有原始表读写被拒；`game_server` 角色最小授权可用 |

公共基建设施见 [helpers.ts](./helpers.ts)：`setupIntegrationDatabase`（CREATE SCHEMA → 在隔离 schema 执行版本化迁移 → 交给仓储层 → 结束 DROP SCHEMA CASCADE）。

## 运行（本地 PostgreSQL 容器示例）

```bash
docker run -d --name tex18-test-postgres -e POSTGRES_PASSWORD=tex18test -p 55432:5432 postgres:16-alpine
TEX_TEST_DATABASE_URL=postgres://postgres:tex18test@localhost:55432/postgres pnpm test:integration
```

需要超级用户或等价权限（迁移创建 `anon`/`authenticated`/`game_server` 角色并做 GRANT/REVOKE）。CI 中未配置测试库时本层受控跳过（TEX-12 基线）。
