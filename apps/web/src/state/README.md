# Client state boundary

这里区分 Server 权威投影、命令状态和纯 UI 状态。`ProjectionStore` 只接受完整 `GameSnapshot` 原子覆盖或相邻 sequence 的 `GAME_EVENT` Patch；乱序、未知/私密字段或 Patch 失败会禁用 Action 并要求完整 Snapshot。uint64 sequence 始终以 `BigInt` 比较。`ProjectionStore` 另以只读的 `currentHandEvents` 缓冲本手已应用的 `GAME_EVENT`（TEX-27，供 Hand History Drawer 的"本手进行中"渲染）；新 handId、任何 Snapshot 或重连屏障都会重置该缓冲，它不是牌局状态的来源。

Jotai atoms 仅保存本地展示状态，不能修改 `PlayerView`、推导 `LegalActions` 或根据 `COMMAND_RESULT` 模拟牌局结果。
