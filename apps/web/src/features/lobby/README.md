# Lobby feature

TEX-24 的 Home/Create/Join/Lobby 客户端流程：创建或加入的 HTTP 响应、以及 Lobby
WebSocket 的 `RECONNECT_RESULT` / `ROOM_SNAPSHOT` 都先经共享 Schema，再写入
`ProjectionStore`。此目录不复制 Room DTO，也不根据 `COMMAND_RESULT` 乐观修改成员、
Ready、座位、权限或锁定状态。

连接 hook 同时监听浏览器 `online` 与恢复可见，以已有 `WebSocketTransport` 的单连接重试流程提前一次尝试；不创建第二套 WebSocket 或投影缓存。

TEX-38 为权威入座/离座/Ready 更新提供 180ms 轻量淡入和 140ms 控件按压反馈；准备好的座位保留静态绿色状态。系统或设备偏好减少动态效果时取消位移，状态内容保持一致。时长复用 `animations/timings.ts`，不会为动画延迟 RoomSnapshot 或锁定操作。

TEX-44 将创建表单按身份、牌桌设置、行动节奏分组，加入页保留邀请码预填并显示大写 6 位输入；时间下拉展示中文单位，值保持原协议。大厅采用座位主区和邀请/配置侧栏，小屏纵向排列。请求 payload、幂等重试、Ready、选座、房主开局与快照消费未变。

TEX-49：`lobby-view.ts` 从权威快照派生邀请可见性与逐成员开局阻塞（P0 至少两名真人、所有成员在线/入座/Ready、无活跃比赛）；未入座成员单列，离线者提示可等待重连或由房主移出。`use-room-mutation.ts` 复用既有 updateRoom/startTournament，提供同步重复提交锁、相同 payload 的幂等重试、过期 revision 后重新认证及卸载取消。Ready 回执只展示错误，状态始终等 RoomSnapshot；新比赛 ID 匹配 GameSnapshot 后全员自动进入牌桌。房主配置编辑器随权威配置更新，邀请码仅 LOBBY 可显示/复制。定向测试：`pnpm exec vitest run --project unit apps/web/src/features/lobby`、`pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round`。

TEX-49 CI 修复：收到 IN_GAME 新 activeTournamentId、但 GameSnapshot 尚无基线或仍是旧场时，按新场号仅执行一次既有 Transport 重新认证；获取权威初始快照后再导航，避免等到 ACTION_OPEN 才从大厅进入。直接广播已有匹配快照时不额外认证。
