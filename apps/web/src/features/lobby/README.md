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

TEX-68：房间大厅升级为可交互实体桌盘与双端零重叠布局（仅消费既有 `RoomSnapshot`，不改协议与后端）。
- `lobby-seat-layout.ts`：纯函数计算 2–10 席在桌面横向椭圆与手机纵向椭圆上的桌沿锚点，并导出 `lobbyLayoutMetrics` 作为 CSS 自定义属性与单元测试的单一几何真源。
- `lobby-table.tsx`：深绿椭圆绒面牌桌、空座整块可点击虚线座垫（为 P1 空位加 AI 预留入口，P0 不显示 AI 控件）、已入座实体身份卡（区分本人/他人、头像首字、在线状态点、房主标记、初始筹码、已准备柔和绿光与卡片内侧边缘相对锚定的鎏金 `✓ READY` / 移动端紧凑 `✓` 筹码）、桌心筹备铭牌（移动端自动抽离至桌顶卡片，桌心仅留盲注水印）与桌下操作坞。
- `lobby-sidebar.tsx`：可视化「开赛条件」勾选清单（由 `lobbyStartChecklist` 派生，与 `lobbyStartBlockers` 保持同源）、默认只读的「比赛结构」2×2 摘要卡（房主点「编辑规则」折叠展开表单）、以及「房间成员 / 等待入座的成员」区（房主移出按钮收纳于对应成员行内，保留原有可访问名称与语义）。
- 样式集中于 `src/app/river-and-raise.css`；定向验证：`pnpm exec vitest run --project unit apps/web/src/features/lobby`、`pnpm exec playwright test -c tests/e2e/playwright.config.ts next-round`。
