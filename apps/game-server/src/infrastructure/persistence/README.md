# Persistence adapters

基于 Supabase PostgreSQL 的持久化实现（Drizzle ORM + `pg`，权威规格：[docs/03-data-model.md](../../../../docs/03-data-model.md)）。数据库是记录与恢复检查点，**不是**运行中牌局状态机，也不参与客户端裁决。

## 结构

| 目录 | 职责 |
| --- | --- |
| [schema/](./schema/README.md) | Drizzle 表/枚举/约束/索引定义（8 张核心表） |
| [database/](./database/README.md) | 连接配置、连接池与事务边界（`pg` + `search_path`） |
| [migrations/](./migrations/README.md) | 版本化迁移（Drizzle Kit 生成 + 受审查手写 SQL）与迁移执行入口 |
| [repositories/](./repositories/README.md) | 控制面与手末 Commit Bundle 仓储接口/实现 |

模块级工具：

- [player-token.ts](./player-token.ts) — `playerToken` 的 HMAC-SHA-256 摘要计算与常数时间比较；原 token 永不落盘。
- [display-name.ts](./display-name.ts) — 昵称校验（2–16 grapheme clusters、无控制字符）与 NFKC+小写规范化键。
- [checksum.ts](./checksum.ts) — canonical JSON（键排序、BigInt 十进制）与 SHA-256 checksum。

公共入口 [index.ts](./index.ts)；领域引擎（`packages/poker-engine`）不得依赖本目录。

## 已实现（TEX-18）

- 8 张表、10 个枚举、全部复合外键/CHECK/部分唯一索引的迁移（0000–0002）。
- Room + 首个 Host、Tournament + locked players 的单事务原子写入。
- 手末 Commit Bundle 原子提交（FOR UPDATE 行锁 + 序列完整性验证 + 幂等重试）。
- 最小权限迁移：`anon`/`authenticated` 对所有原始表默认拒绝；`game_server` 专用角色最小授权。

## 未实现（后续任务）

- 异步写入队列、退避与 watermark（TEX-20/TEX-22，见 docs/04 §12/§16）。
- 崩溃恢复编排、Hand History 投影读取（TEX-22）。
- 保留期清理任务（docs/03 §5.10）。
