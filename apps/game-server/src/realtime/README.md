# Server realtime

服务端实时传输层。负责协议适配和连接管理，不负责裁决扑克规则。

TEX-21 在 TEX-24 的同一 Gateway 上补齐完整生命周期：首帧强制认证、协议版本
校验、`RECONNECT_RESULT` 中的 Room/Game 权威快照、Tournament 事件/时钟扇出与
`REQUEST_SNAPSHOT` 重同步。Ready/离开仍经 Room/Tournament 串行权威路径处理；
`COMMAND_RESULT` 仅是回执，绝不拼装或修改 Room/Game 投影。

每个 `(roomId, playerId)` 仅保留最新连接；被替换的连接收到
`SESSION_REPLACED` 后关闭。连接 epoch 会在 Tournament 执行器真正处理命令时再
校验，故旧 Socket 已排队的 Ready/离开/Action/Time Bank 也不能在接管后生效。`CLOCK_UPDATED`
按接收者携带其本人 Time Bank 余额。已认证连接每
15 秒 Ping，并在 45 秒未收到 Pong 或有效入站命令时终止。成员离开或被移出投影后
立即取消订阅，避免继续接收房间数据。Timer 通过注入 Clock 测试，不依赖 sleep。
