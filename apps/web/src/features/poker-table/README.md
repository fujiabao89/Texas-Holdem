# Poker table feature

TEX-38 的 `event-feedback.ts` 只映射公开事件为中文动作/金额/牌型及 DOM 坐标；筹码从对应座位飞向实测 Pot，退回/派奖反向飞向服务端指定玩家。Burn 与 Fold 仅移动牌背；每 Pot 的分配逐条显示赢家与金额。静态本手结果保留已展示的公开牌型、最佳五张与分池金额，减少动态效果时同样可读。Reveal 和各动作以队列 `eventKey` 重建动画实例；最新行动者、下注按钮和时钟使用 canonical。页面视觉关键帧仅 transform/opacity，几何在 layoutEffect 中每任务测量并缓存，公共牌先到位再翻面。

回归：`pnpm exec vitest run --project unit apps/web/src/features/poker-table --maxWorkers 1`；浏览器见 [animation-audio](../../../../../tests/e2e/animation-audio/README.md)。

牌桌状态投影、2–10 Seat 布局、公共牌、底池、行动者、可见底牌及终局排名展示（TEX-25）。视觉层为白色页面中的深青绿色椭圆牌桌：本人始终位于下方，公共牌与底池居中，其他已入座玩家环绕，操作区以白色悬浮面板呈现。明牌采用项目化的标准扑克样式：真实牌宽高比、四角牌值和花色、2–10 的牌点阵列、A 的居中大花色；底牌则使用蓝色花纹牌背。组件只消费 `ProjectionStore` 的权威 Snapshot/Event/Clock 镜像；私有牌只读取 `viewer.holeCards`，其他玩家只显示已投影公开牌或牌背。

`table-state.ts` 保持为可测的纯展示准入逻辑：没有当前行动、连续投影、有效连接或存在 pending 命令时不展示操作区。它不计算筹码、合法性或胜负。

TEX-26/TEX-27 合并时，顶部历史按钮和音效开关共用一个控件组，连接状态只渲染一次；牌桌容器及其 Deck/定位 ref 也只保留一套。TEX-27 的历史抽屉、淘汰观战提示和赛果入口读取 canonical，关闭历史后焦点返回按钮；倒计时的行动机会 key 同样读取 canonical，不随动画积压延迟切换。

Showdown 的 canonical target 可以先包含多个已公开 `revealedCards`；Seat 仍只根据 presentation 中已完成的逐人 `PLAYER_REVEALED` 显示对手牌。Snapshot 屏障则直接对齐权威终态，不重放旧 Reveal。

TEX-26 的牌桌将队列 presentation state 仅用于牌、筹码和 Overlay；下注区、倒计时和命令 payload 一律使用最新 canonical Snapshot。物理 Deck 固定在牌桌外左上角的白色留白区，不占用任何玩家手牌或 Board 空间；每张手牌按其已投影的 `DEAL_HOLE_CARD` 读取 Deck 与牌桌的实际 DOM 边界，从同一 Deck 沿 transform/opacity 合成层的浅弧线、保持正向地飞向目标座位。第一、二轮的每张牌背都对全桌可见，第二轮最后一张落定后，本人才将服务端投影的两张牌依次纵轴翻开，其他人始终只有牌背；`cardIndex` 还用于把两轮牌落在手牌区左右两侧。每个 `handId + playerId + cardIndex` 都生成新的飞行组件 key，保证连续发牌不会复用已经结束的 CSS animation。TEX-38 改为 `event-feedback.ts` 的 DOM 实测坐标，逐任务读取 Deck、Seat 左右手牌槽和 Pot；`deal-flight.ts` 保留原独立工具与单元资产，不再作为当前 UI 几何入口，其测试不代替实际页面验收。公共牌在对应目标框中按“入框 → 停顿 → 翻面”逐张可读地呈现，Soft Catch-up 不会抢先以 canonical Board 替换尚未翻完的第三张；Burn Overlay 没有牌面。Showdown 先摊开服务端公开的底牌，再使七张已公开候选牌中非最佳牌淡出并组合 `PLAYER_REVEALED.handRank.bestFiveCards`，并保留 Best Five 的长阅读停留；前端只比较卡牌身份以展示服务端已判定集合，绝不计算牌型或赢家。牌桌提供音效开关、非阻断重连提示、`EXIT_PENDING`/`WITHDRAWN` 文案及 `SESSION_REPLACED` 的键盘可达阻断对话框。

手机牌桌使用更高的纵向布局，拉开十人座位并给五张公共牌留出独立中间区域；允许纵向滚动至操作区，桌面保持横向椭圆。360/390/1366 像素的座位矩形不相交和下注可操作性由专用 E2E 检查。
