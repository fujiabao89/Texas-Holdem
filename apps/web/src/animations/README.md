# Animations

对服务端**已连续应用**的 Event 进行排队和呈现。`AnimationQueue` 从 `ProjectionStore.subscribeAcceptedGameEvents` 接收 `{ message, afterCanonical }`，只维护 presentation state；取消、异常、超时和 Reduced Motion 均提交终帧。Snapshot/重连通知是屏障，清空旧任务且不回放断线期间事件；Hard Fast Forward 仅请求既有的权威 Snapshot，绝不发送游戏 Action。

手牌任务只使用已过滤的 `DEAL_HOLE_CARD`：所有客户端都将牌背从同一可见 Deck 沿上扬弧线飞向 `seat` 对应手牌区，本人仅在 Event 已携带的 `card` 存在时于到位后翻面；绝不从 Snapshot 回填对手牌面。Deck 位于 Board 层下方，飞行只动画 transform/opacity，目标坐标由牌桌尺寸与座位展示坐标得出，不触碰 canonical state。公共牌任务携带该 Event 的公开牌和动画前 Board 长度：Flop/Turn/River 在目标牌框中从 Deck 方向到位、再翻面；不为 Burn 生成牌面。`PLAYER_REVEALED` 只携带服务端公开的 `handRank.bestFiveCards`，牌桌仅以该字段让七张候选牌中的非最佳牌淡出并组合五张，不计算牌型、赢家或补牌。

节奏常量集中于 `timings.ts`：公共牌保留完整的“飞入目标框 → 停顿 → 翻面”时间，Showdown 保留候选牌、未选牌淡出和 Best Five 组合的长停留；Soft Catch-up 仅压缩普通动作反馈，绝不提早提交这些语义帧的 canonical 终态，因此不会让第三张公共牌跳帧。音频控制器复用同一公共牌节拍。
