# Animations

对服务端**已连续应用**的 Event 进行排队和呈现。`AnimationQueue` 从 `ProjectionStore.subscribeAcceptedGameEvents` 接收 `{ message, afterCanonical }`，只维护 presentation state；取消、异常、超时和 Reduced Motion 均提交终帧。Snapshot/重连通知是屏障，清空旧任务且不回放断线期间事件；Hard Fast Forward 仅请求既有的权威 Snapshot，绝不发送游戏 Action。

手牌任务只使用已过滤的 `DEAL_HOLE_CARD`：所有客户端都将牌背从同一可见 Deck 沿浅弧线、保持正向地飞向 `seat` 对应手牌区。队列按实际收到的 `cardIndex=0/1` 记录两轮展示进度，第二轮最后一张落定后，才将服务端已投影的 `viewer.holeCards` 作为一组依次纵轴翻开；绝不从 Snapshot 回填或推导对手牌面。最后一张飞行牌与 Seat 牌背在同一个 `900ms` 边界原子交接，飞行副本随即隐藏，不能叠在翻牌层上造成偶发闪背。Deck 位于牌桌外白色区且不与公共牌纵向相交；飞行只动画 transform/opacity，目标坐标由牌桌尺寸、座位展示坐标与 `cardIndex` 得出，不触碰 canonical state。每个投影 Event 使用 `handId/playerId/cardIndex` 唯一展示 key，强制浏览器为每张牌创建新的动画实例。公共牌任务携带该 Event 的公开牌和动画前 Board 长度：Flop/Turn/River 在目标牌框中从 Deck 方向到位、再翻面；不为 Burn 生成牌面。`PLAYER_REVEALED` 只携带服务端公开的 `handRank.bestFiveCards`，牌桌仅以该字段让七张候选牌中的非最佳牌淡出并组合五张，不计算牌型、赢家或补牌。

节奏常量集中于 `timings.ts`：公共牌保留完整的“飞入目标框 → 停顿 → 翻面”时间，Showdown 保留候选牌、未选牌淡出和 Best Five 组合的长停留；Soft Catch-up 仅压缩普通动作反馈，绝不提早提交这些语义帧的 canonical 终态，因此不会让第三张公共牌跳帧。超过 28 秒/40 Event 的积压会在已展示一段公开 Showdown 语义后重新判断 Hard Forward。音频控制器复用同一公共牌节拍。

TEX-38 将入队时的两轮收件人规划与播放时的每手落牌进度分开，下一手提前入队不清空正在播放的手牌。每个 Overlay 提供 `eventKey`（比赛/手局/sequence）与实际 `durationMs`，包含 Soft Catch-up 后的动作时长。已完成公开 Reveal 与每 Pot 分配保存在有界 `outcomeEvents`（每玩家/每 Pot 一条）；换手和 Snapshot 清空，静态摘要不构成另一份权威牌局状态。跳帧一次性对齐终态，不依次渲染被跳过的每帧。

`use-table-presentation.ts` 连接可见性、用户/系统动态偏好和 `FrameHealth`。隐藏时停止队列和声音，隐藏期连续事件仅对齐当前终态；恢复时请求既有权威 Snapshot，不补播。系统或用户减少动态效果时保留当前事件的即时 cue 和公开结果；切换偏好不会重播刚丢弃的声音。可见动画期间每 24 帧中至少 6 帧耗时超过 34ms 即为本牌桌会话启用相同降级，单次长帧不触发，后台间隔不计入。该检测不参与游戏计时。

Hard Forward 保留可见模式、120ms 过渡和 3 秒提示；已有公开结果时先静态停留 1 秒再请求 Snapshot。超过两倍队列事件上限时强制收敛，以免极端连续事件让 Showdown 保护无限延期。取消、Snapshot 与卸载清理所有任务及提示 timer。音频回调异常只影响声音，不缩短牌面展示。

验证：`pnpm exec vitest run --project unit apps/web/src/animations --maxWorkers 1`。`presentation-lifecycle.test.ts` 专测跨手、后台、快进、去重、静态分池、降级音效与清理；浏览器回归见 [animation-audio](../../../../tests/e2e/animation-audio/README.md)。权威体验契约见 [前端规格 §9.7](../../../../docs/05-frontend-spec.md#97-tex-38-体验优化契约2026-09-05)。
