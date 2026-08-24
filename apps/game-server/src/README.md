# Game server source

服务端源码根目录。不得将扑克规则、牌力计算或底池裁决放在此处；它们属于共享引擎包。

## 模块

| 目录 | 职责 | 权威规格 |
| --- | --- | --- |
| `http/` | HTTP 入口与安全（routes/middleware/errors） | docs/04 §10；docs/02 §4/§8/§11 |
| `rooms/` | Room/Lobby 权威状态、串行执行器、集合管理、凭证 | docs/04 §5；docs/02 §5 |
| `infrastructure/persistence/` | Supabase PostgreSQL 持久化（Schema/迁移/连接/仓储，TEX-18） | docs/03 |
| `app.ts` / `main.ts` / `config.ts` | Fastify 装配、进程入口、运行时配置 | docs/04 §4.1 |
