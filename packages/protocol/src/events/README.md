# Events

服务端到客户端的严格消息 Schema。每条消息携带 v3 `protocolVersion` 和 `serverTime`；`GAME_EVENT` 额外固定 `tournamentId`、nullable `handId` 与 uint64 十进制 `sequence`。事件投影保留这些身份字段，只删除未授权的私有发牌字段。

`TOURNAMENT_FINISHED.winnerPlayerId` 为 null 时明确表示无冠军，此时排名可为空；有冠军仍要求非空 ID 和至少一项排名。旧主版本由现有版本门禁拒绝。

`PLAYER_REVEALED.handRank.bestFiveCards` 为服务端裁决后公开的恰好五张牌；客户端只可展示/高亮该字段，不能从底牌和 Board 重算。
