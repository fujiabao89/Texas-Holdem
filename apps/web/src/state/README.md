# Client state boundary

TEX-38 的 `presentation-preferences.ts` 是设备级展示偏好来源，设置页与牌桌通过 `use-presentation-preferences.ts` 共用它；不再使用 `soundEnabledAtom`。键为 `texas-holdem:sound-enabled`（兼容 0/1）、`texas-holdem:sound-volume`（0–1，默认 0.8）和 `texas-holdem:motion`（system/reduce）。缓存快照保证 SSR/hydration 一致；同页订阅和跨标签 storage 更新同步，存储异常在本页生命周期降级到内存。偏好不含身份、Token 或牌局数据；单元覆盖见 `presentation-preferences.test.ts`。

这里区分 Server 权威投影、命令状态和纯 UI 状态。`ProjectionStore` 只接受完整 `GameSnapshot` 原子覆盖或相邻 sequence 的 `GAME_EVENT` Patch；乱序、未知/私密字段或 Patch 失败会禁用 Action 并要求完整 Snapshot。uint64 sequence 始终以 `BigInt` 比较。`ProjectionStore` 另以只读的 `currentHandEvents` 缓冲本手已应用的 `GAME_EVENT`（TEX-27，供 Hand History Drawer 的"本手进行中"渲染）；新 handId、任何 Snapshot 或重连屏障都会重置该缓冲，它不是牌局状态的来源。

Jotai atoms 仅保存本地展示状态，不能修改 `PlayerView`、推导 `LegalActions` 或根据 `COMMAND_RESULT` 模拟牌局结果。

TEX-26 额外提供只读 `subscribeAcceptedGameEvents`（仅在连续 Patch 已写入 canonical 后）和 `subscribeBarriers`（`GAME_SNAPSHOT` / `RECONNECT_RESULT`）。两者仅供 presentation 消费，不能写回投影。

连续 `GAME_EVENT` 还必须与 Patch 前后手局身份一致；不一致时不更新 canonical，而是进入 `INVALID_EVENT` resync，防止动画 Event 身份与权威投影分叉。

TEX-26/TEX-27 合并后，每个合法 Event 只提交一次 canonical、Clock 与 `currentHandEvents`，提交后才通知动画；Snapshot/重连先清空历史缓冲，再发出 presentation 屏障。`projection-store.test.ts` 联合断言这两种消费者的顺序、幂等和新手局身份切换。
