# Events

服务端到客户端的严格消息 Schema。每条消息携带 v5 `protocolVersion` 和 `serverTime`；`GAME_EVENT` 额外固定 `tournamentId`、nullable `handId` 与 uint64 十进制 `sequence`。事件投影保留这些身份字段，只删除未授权的私有发牌字段。Snapshot 与 patch 的盲注座位与展示截止时间契约见协议规格 §9.2。

`TOURNAMENT_FINISHED.winnerPlayerId` 为 null 时明确表示无冠军，此时排名可为空；有冠军仍要求非空 ID 和至少一项排名。旧主版本由现有版本门禁拒绝。

`PLAYER_REVEALED.handRank.bestFiveCards` 为服务端裁决后公开的恰好五张牌；客户端只可展示/高亮该字段，不能从底牌和 Board 重算。

`CLOCK_UPDATED` 携带权威行动/展示时钟与接收者本人的 Time Bank 余额；`showdownDisplayUntil` 非空时与 `actionDeadline` 互斥且 `currentActorPlayerId` 必须为 null。详见 [02](../../../../docs/02-protocol-spec.md) §8.4。
