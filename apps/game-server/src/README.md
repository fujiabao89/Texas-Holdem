# Game server source

服务端源码根目录。不得将扑克规则、牌力计算或底池裁决放在此处；它们属于共享引擎包。

## 模块

| 目录 | 职责 | 权威规格 |
| --- | --- | --- |
| `http/` | HTTP 入口与安全（routes/middleware/errors） | docs/04 §10；docs/02 §4/§8/§11 |
| `rooms/` | Room/Lobby 权威状态、串行执行器、集合管理、凭证、TournamentStarter port | docs/04 §5；docs/02 §5 |
| `tournaments/` | Tournament 运行时、单桌串行执行器、集合管理、手末 Commit Bundle 构造（TEX-20） | docs/04 §6/§7；docs/02 §7；docs/03 §7 |
| `scheduler/` | 可注入 Timer Scheduler（行动超时/断线宽限/定时升盲，TEX-20） | docs/04 §8 |
| `projection/` | `PlayerView`/wire `GameEvent`/Patch 投影（TEX-20；字段级安全） | docs/02 §9；docs/04 §11 |
| `infrastructure/persistence/` | Supabase PostgreSQL 持久化（Schema/迁移/连接/仓储，TEX-18） | docs/03 |
| `app.ts` / `main.ts` / `config.ts` | Fastify 装配、进程入口、运行时配置 | docs/04 §4.1 |
