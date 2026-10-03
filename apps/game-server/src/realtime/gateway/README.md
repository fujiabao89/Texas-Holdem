# Gateway

TEX-61：`connection-outbox.ts` 对每连接串行发送并监控未交给 Socket 的事件数/年龄及总字节。触发背压后只保留一个恢复意图，在传输可继续时重新投影当前 Snapshot，按顺序写出 RESYNC_REQUIRED / GAME_SNAPSHOT，过滤快照 sequence 已覆盖的迟到扇出。所有控制回复也受硬字节限约束。成员撤销丢弃旧牌局帧，最终 Lobby 回执传输完成后关闭。阈值唯一权威为 [04 §9.5](../../../../../docs/04-game-server-architecture.md#95-事件积压与-fast-forward)；传输完成只表示 send callback 成功，不表示客户端读到或播放完成。

`connection-outbox.test.ts` 验证阈值边界、控制积压不重置恢复期限、在途恢复快照后的同序列更新、回拨时指标异常隔离、字节上限和延迟回调清理；`lobby-gateway.test.ts` 验证玩家隔离、换手最新快照、序列屏障、1013 与重新认证，以及成员撤销后回执排空/超时两条关闭路径。最终回执等待上限以 04 §9.5 为准，到期释放 outbox 并按成员结束关闭，不延长身份权限。既有真实 WS 测试同时覆盖 Node send callback 的行为。


TEX-52：Room CLOSED 同步发送最终房间投影、撤销所有 epoch/订阅/心跳，Socket 关闭等待该连接在途 Lobby 命令的回执发送完毕。Gateway 全局订阅在 app.close 时注销。请求同 Room 的终局保留 Tournament 时允许最终 Snapshot 和原 Action/TimeBank 幂等查账，新动作由执行器拒绝；旧赛不能控制新赛，跨房间仍拒绝。

WebSocket 接入、认证握手和消息路由入口。

`lobby-gateway.ts` 适配认证、Lobby 命令、Tournament Action/Time Bank、快照重同步
和服务端投影广播；它不直接修改 RoomState、Tournament Runtime 或 Engine，也不向
客户端发送 Token 或服务端内部状态。

同一玩家的新连接会原子替换旧连接；connection epoch 在 Tournament 队列执行点再次
验证。心跳为 15 秒 Ping / 45 秒失活关闭。变更命令按玩家、`requestId` 与完整
payload 复用幂等结果，成员不再存在于权威投影时会撤销该连接的订阅并关闭连接。

wire v6 握手版本由共享协议包决定；`lobby-gateway.test.ts` 验证旧版本（如 v3/v4）首帧得到 `UNSUPPORTED_PROTOCOL_VERSION`，不会建立旧版本订阅。

TEX-53 的 gateway 单元覆盖 INITIAL、GAP→RESYNC 和重连的新快照 D/SB/BB 一致；真实 HTTP/WS 链路与开手事件对照见 `tests/clients/server-harness.test.ts`。

TEX-60：Schema 后立即固定接收时间/Action 入口序号，后续成员检查耗时不改变 receivedAt。TIME_SYNC 仅允许已认证当前 epoch，直接回复 serverReceivedAt/serverSentAt，不续发 deadline。gateway 单元覆盖校时无状态副作用、未认证/伪造字段拒绝与慢访问检查。当前 wire 为 v6。
