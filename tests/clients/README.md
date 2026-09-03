# Test clients

TEX-28 多客户端联调与安全测试基础设施（Multiplayer/WS 层）。

## 模块

| 文件 | 职责 |
| --- | --- |
| [server-harness.ts](./server-harness.ts) | 进程内全链路 server harness：以生产装配方式（`main.ts` 同一接线）构建真实 `RoomManager`/`TournamentManager`/`TournamentEventBus`/`LobbyGateway`/HTTP 路由，仅以内存 `InMemoryRoomRepository` Fake 替代 PostgreSQL；时间完全由 `FakeClock` 驱动，洗牌由 `SeededRandomSource` 按场景 seed 派生 |
| [in-memory-room-repository.ts](./in-memory-room-repository.ts) | 内存版 `RoomRepository`：契约与真实 `rooms.ts` 一致（原子性语义、昵称唯一性），用于协议/运行时行为测试；数据库事务结论由 Integration 层真实 PostgreSQL 测试负责 |
| [ws-client.ts](./ws-client.ts) | 可编程真实 WebSocket 客户端：每条入站帧以 `ServerMessageSchema` 严格校验（递归拒绝未知字段），原文保留供字段级安全扫描；故障注入由测试在发送侧以 `onSend` 故障脚本表达 |

## 边界

- 本目录仅用于 **Multiplayer/WS 层** 协议与运行时行为测试（docs/06 §6/§7）；不是生产代码。
- 内存 Fake 替代持久化仓储：协议级行为（认证、心跳、接管、幂等、序列、投影隐私）全部走真实代码路径；持久化事务、权限与历史读取结论必须由 `apps/game-server/tests/integration` 的真实 PostgreSQL 测试支持（docs/06 §3.2/§2.1）。
- 等待条件只挂接在真实到达的消息上（可观察状态），禁止任意 sleep；时序由 `FakeClock` 驱动（docs/06 §2.1）。
- 洗牌随机由 `SeededRandomSource` 按 seed 派生，失败可 100% 重放（docs/06 §6）。
- 故障注入测试必须记录故障脚本和 seed，明确区分真实链路与协议模拟（docs/06 §6）。