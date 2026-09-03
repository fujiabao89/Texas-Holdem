# Client state boundary

这里区分 Server 权威投影、命令状态和纯 UI 状态。`ProjectionStore` 只接受完整 `GameSnapshot` 原子覆盖或相邻 sequence 的 `GAME_EVENT` Patch；乱序、未知/私密字段或 Patch 失败会禁用 Action 并要求完整 Snapshot。uint64 sequence 始终以 `BigInt` 比较。`ProjectionStore` 另以只读的 `currentHandEvents` 缓冲本手已应用的 `GAME_EVENT`（TEX-27，供 Hand History Drawer 的"本手进行中"渲染）；新 handId、任何 Snapshot 或重连屏障都会重置该缓冲，它不是牌局状态的来源。

Jotai atoms 仅保存本地展示状态，不能修改 `PlayerView`、推导 `LegalActions` 或根据 `COMMAND_RESULT` 模拟牌局结果。

TEX-26 额外提供只读 `subscribeAcceptedGameEvents`（仅在连续 Patch 已写入 canonical 后）和 `subscribeBarriers`（`GAME_SNAPSHOT` / `RECONNECT_RESULT`）。两者仅供 presentation 消费，不能写回投影。

连续 `GAME_EVENT` 还必须与 Patch 前后手局身份一致；不一致时不更新 canonical，而是进入 `INVALID_EVENT` resync，防止动画 Event 身份与权威投影分叉。

TEX-26/TEX-27 合并后，每个合法 Event 只提交一次 canonical、Clock 与 `currentHandEvents`，提交后才通知动画；Snapshot/重连先清空历史缓冲，再发出 presentation 屏障。`projection-store.test.ts` 联合断言这两种消费者的顺序、幂等和新手局身份切换。
