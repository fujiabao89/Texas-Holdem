# Client state boundary

这里区分 Server 权威投影、命令状态和纯 UI 状态。`ProjectionStore` 只接受完整 `GameSnapshot` 原子覆盖或相邻 sequence 的 `GAME_EVENT` Patch；乱序、未知/私密字段或 Patch 失败会禁用 Action 并要求完整 Snapshot。uint64 sequence 始终以 `BigInt` 比较。

Jotai atoms 仅保存本地展示状态，不能修改 `PlayerView`、推导 `LegalActions` 或根据 `COMMAND_RESULT` 模拟牌局结果。

TEX-26 额外提供只读 `subscribeAcceptedGameEvents`（仅在连续 Patch 已写入 canonical 后）和 `subscribeBarriers`（`GAME_SNAPSHOT` / `RECONNECT_RESULT`）。两者仅供 presentation 消费，不能写回投影。

连续 `GAME_EVENT` 还必须与 Patch 前后手局身份一致；不一致时不更新 canonical，而是进入 `INVALID_EVENT` resync，防止动画 Event 身份与权威投影分叉。
