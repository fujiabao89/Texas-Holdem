# ADR-0007：显式重新开放下一轮筹备大厅

- 日期：2026-10-23
- 状态：采纳（TEX-48）

TEX-37 的单命令 FINISHED → LOBBY → IN_GAME 没有可加入、可重新准备的中间大厅。TEX-48 将该历史行为替换为房主显式 `REOPEN_LOBBY`，再经独立开局命令创建新 Tournament；前端接入属于 TEX-49。

`PATCH /api/v1/rooms/{roomId}` 新增 `{ expectedRoomRevision, operation: { type: "REOPEN_LOBBY" } }`，复用身份认证、Idempotency-Key 和 Room 串行队列。仅当前房主、FINISHED 且无活跃比赛可执行。相同幂等键重放原响应；不同键使用旧 revision 返回 STALE_ROOM_STATE，错误状态返回 ROOM_LOCKED，非房主返回 NOT_HOST。开始比赛只接受 LOBBY。

内部保留原邀请码，公开 Snapshot 仅 LOBBY 暴露。重新开放保留合法座位、配置、当前成员和房主；真人 ready=false、pokerStatus=ACTIVE，移除的成员不恢复。P0 开局要求所有真人在线、入座并重新准备且至少两名真人。P1 如已存在 Bot，保持至少两名总参赛者且至少一名真人、Bot 默认 Ready 并使用新参赛快照；本任务不增设 Bot 入口。

既有 60 秒 Host Grace 由 Room 生命周期拥有，适用于 LOBBY/FINISHED；Timer 仅投递带代次的 Room 命令，在队列中复核状态和当前房主。无人在线时保留待转移状态，下一次真人连接再裁决。重连取消旧代次，关闭/卸载清理 Timer。恢复不伪造 Ready。

持久化沿用现有 Room 状态和成员表，无迁移。下一场使用新 ID、递增场号、配置初始筹码；旧 Tournament/Hand History 独立保留。旧终局队列信号按 tournamentId 拒绝，延迟 Bundle 不得覆盖 LOBBY 或较新的比赛。

未采用轮换邀请码（产品要求恢复同一码）或隐式双迁移（不能筹备）。协议字段形状不变，仅增加 HTTP operation 并收紧邀请码投影；服务端先发布，旧前端的直接再开局将收到 ROOM_LOCKED，必须由 TEX-49 完成产品入口。
