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
| `realtime/` | 单一 WebSocket Gateway：认证、接管 epoch、心跳、重连/请求时的 Game Snapshot、Room 投影与 Runtime 事件扇出（TEX-21）；Lobby 变更不重置 Game Snapshot | docs/02 §4/§6/§10；docs/04 §9 |
| `infrastructure/persistence/` | Supabase PostgreSQL 持久化（Schema/迁移/连接/仓储，TEX-18；恢复读取/回退仓储，TEX-22） | docs/03 |
| `persistence/` | 持久化运行时编排（TEX-22）：异步 Writer（队列/退避/watermark/flush）与崩溃恢复（校验/重建/向前退回） | docs/04 §12/§13 |
| `app.ts` / `main.ts` / `config.ts` | Fastify 装配、进程入口（含启动恢复屏障、优雅关停与 backpressure 门控，TEX-22）、运行时配置 | docs/04 §4.1/§13 |
