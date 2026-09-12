# Migrations

版本化数据库结构演进（Drizzle Kit 生成 + 受审查手写 SQL；禁止对任何共享环境使用 `drizzle-kit push`）。

## 当前迁移

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `0000_init.sql` | 全部表、枚举、CHECK、复合 FK、唯一/部分索引 | `drizzle-kit generate`（生成后人工审查修正） |
| `0001_deferrable_composite_fks.sql` | `rooms.host_player_id` 与 `tournaments.champion_tournament_player_id` 的 DEFERRABLE 复合外键（循环依赖，Drizzle 无法表达） | 手写 |
| `0002_least_privilege.sql` | 最小权限：REVOKE `anon`/`authenticated`/PUBLIC；GRANT `game_server` | 手写 |
| `0003_room_revision_reservation.sql`（TEX-51） | `rooms.room_revision_ceiling`：默认 `2^32-1`，以 CHECK 限制到 JavaScript 安全整数；重启时原子预留下一个号段，避免旧客户端 revision 与重置状态碰撞（[ADR-0003](../../../../../../docs/adr/0003-tex-51-room-recovery-authority.md)） | 手写、同步 Drizzle schema / snapshot |

`meta/_journal.json` 登记以上四者；`meta/0000_snapshot.json` 与 `meta/0003_snapshot.json` 仅反映 Drizzle 表达的子集（两个 DEFERRABLE FK 与权限不在 snapshot 中）。

TEX-51 发布前须先执行迁移 `0003`。该字段为现存 Room 自动回填首个号段上界；应用回滚可保留字段，但旧应用不遵守 revision 上界，不能据此保证随后再次升级时的严格单调，部署边界见 ADR-0003。迁移只增加列与约束，不读取或变更成员凭证、手牌或历史数据。

## 命令

```bash
pnpm --filter @texas-holdem/game-server db:generate   # 从 schema/ 生成新迁移（见下方审查清单）
pnpm --filter @texas-holdem/game-server db:migrate    # 执行迁移（DATABASE_URL + DATABASE_SCHEMA）
```

生产/本地执行 `db:migrate`（[migrate.ts](./migrate.ts)：CREATE SCHEMA IF NOT EXISTS → drizzle-orm migrator，目标 schema 由 `DATABASE_SCHEMA` 决定）；测试由 `tests/integration/helpers.ts` 在隔离 schema 上执行同一迁移。

## 新增迁移的强制审查清单

1. **去 `"public".` 前缀**：drizzle-kit 生成的 SQL 会给 TYPE/FK 引用加 `"public".` 前缀，必须全部移除，否则对象固定落在 public schema、破坏 search_path 隔离。
2. **复合 FK 顺序**：引用复合 UNIQUE 索引的 `ALTER TABLE ... ADD CONSTRAINT` 必须排在对应 `CREATE UNIQUE INDEX` 之后（PostgreSQL 要求被引用键先有唯一约束）。
3. **UTF-8 无 BOM** 写回（BOM 会导致 migrator 首条语句语法错误）。
4. **手写迁移登记**：在 `meta/_journal.json` 追加条目（`idx` 递增、`tag` 为文件名）。
5. Drizzle 表达不了的 DDL（DEFERRABLE FK、权限等）写在手写 SQL 迁移中，同时保证对应 TS schema 不声明它（避免未来 generate 误删）。

## 生成后处理脚本（本地，不入库）

本任务使用仓库外临时脚本完成上述 1–3；后续任务生成新迁移时按同一清单人工处理或重建脚本。
