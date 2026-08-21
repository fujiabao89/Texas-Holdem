# P0 任务卡：协议、数据与游戏服务端

> 覆盖 Linear TEX-17 至 TEX-22。服务端是唯一真实状态源；浏览器和数据库均不裁决扑克结果。

## TEX-17：通信协议

- **Linear / 分支**：[TEX-17](https://linear.app/texas-holdem/issue/TEX-17/feattex-17-implement-protocol-schemas-and-player-projections) · `feat/TEX-17-implement-protocol-schemas-and-player-projections`
- **主责**：Claude Code
- **前置**：TEX-15。
- **要做什么**：实现 HTTP/WS Schema、推导类型、命令/事件/Snapshot/Error 信封和按玩家投影。
- **关键点**：所有 WS 变更命令使用 `requestId`；`SUBMIT_ACTION` 另使用 `actionId` 与 `expectedSequence`。事件使用 `tournamentId`、`handId` 与字符串序列号；客户端和服务端不得维护平行 DTO。
- **完成标准**：不兼容版本和非法字段安全拒绝；其他玩家底牌、Deck、Burn Card、Token 永不进入未授权 Payload。
- **权威参考**：`docs/02-protocol-spec.md` §4～§14。

## TEX-18：数据库

- **Linear / 分支**：[TEX-18](https://linear.app/texas-holdem/issue/TEX-18/feattex-18-implement-supabase-schema-and-persistence-repositories) · `feat/TEX-18-implement-supabase-schema-and-persistence-repositories`
- **主责**：Trae Work
- **前置**：TEX-12。
- **要做什么**：建立 Room、Player、Tournament、Hand、Event、Snapshot 的迁移、索引、约束和仓储接口。
- **关键点**：数据库保存事实，不成为运行中牌局状态机；浏览器权限不能直读私密原始事件或快照。
- **完成标准**：手末 Snapshot 与结构化 Event 按顺序持久化；最小权限和敏感字段隔离有集成测试。
- **权威参考**：`docs/03-data-model.md` §4～§10、§15。

## TEX-19：房间与大厅后端

- **Linear / 分支**：[TEX-19](https://linear.app/texas-holdem/issue/TEX-19/feattex-19-implement-room-lobby-and-http-lifecycle) · `feat/TEX-19-implement-room-lobby-and-http-lifecycle`
- **主责**：Claude Code
- **前置**：TEX-17、TEX-18。
- **要做什么**：实现创建/加入、邀请码、昵称、选座、Ready、房主配置/踢人/转移与开局锁定。
- **关键点**：邀请码只定位房间，不是身份凭证；开局要求 2–10 名真人且所有真人均 Ready。
- **完成标准**：客户端不能替他人操作；配置只在 Lobby 可修改；邀请与加入接口具备限流。
- **权威参考**：`docs/04-game-server-architecture.md` §5、§10；`docs/02-protocol-spec.md` §4、§5。

## TEX-20：比赛运行时

- **Linear / 分支**：[TEX-20](https://linear.app/texas-holdem/issue/TEX-20/feattex-20-implement-tournament-runtime-and-authoritative-timers) · `feat/TEX-20-implement-tournament-runtime-and-authoritative-timers`
- **主责**：Claude Code
- **前置**：TEX-19。
- **要做什么**：实现单桌串行执行器、比赛循环、服务端计时、Time Bank、离开和无真人关房。
- **关键点**：Action 与 Timer 均走同一队列；以服务端 `receivedAt` 与截止时间裁决竞争。
- **完成标准**：服务端独立决定回合、倒计时、合法金额和结果；客户端不能直接改变牌局状态。
- **权威参考**：`docs/04-game-server-architecture.md` §6～§8、§12、§16；《德州扑克项目总规划》§3～§5。

## TEX-21：实时联机与重连

- **Linear / 分支**：[TEX-21](https://linear.app/texas-holdem/issue/TEX-21/feattex-21-implement-websocket-auth-sync-and-reconnect) · `feat/TEX-21-implement-websocket-auth-sync-and-reconnect`
- **主责**：Claude Code
- **前置**：TEX-20。
- **要做什么**：实现 WebSocket 认证、心跳、单活跃连接、Snapshot + Event Stream、幂等命令和重连。
- **关键点**：同一 `requestId` 的相同命令复用原结果；同一 `actionId`、相同业务 Payload 的动作至多执行一次并返回原结果，复用键但 Payload 不同则拒绝。漏序、积压和过期状态必须重取 Snapshot。
- **完成标准**：刷新、切网、后台恢复均能回到合法最新状态；多设备不能并发操纵同一玩家。
- **权威参考**：`docs/02-protocol-spec.md` §6～§10、§14；`docs/04-game-server-architecture.md` §7、§9、§11。

## TEX-22：历史记录与监控

- **Linear / 分支**：[TEX-22](https://linear.app/texas-holdem/issue/TEX-22/feattex-22-complete-hand-history-recovery-and-server-observability) · `feat/TEX-22-complete-hand-history-recovery-and-server-observability`
- **主责**：Trae Work
- **前置**：TEX-18、TEX-21。
- **要做什么**：完成用户视角 Hand History、手末恢复、优雅关停、脱敏日志、指标和告警适配。
- **关键点**：P0 只承诺恢复至最近手末 Snapshot；不宣称进行中 Hand 无损恢复。
- **完成标准**：日志/指标没有 Token、Deck 或未公开底牌；可验证指标到 Dashboard、告警的完整链路。
- **权威参考**：`docs/03-data-model.md` §4、§7～§10；`docs/04-game-server-architecture.md` §12、§13；`docs/06-testing-strategy.md` §10.2。
