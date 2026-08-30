# Poker table feature

牌桌状态投影、2–10 Seat 布局、公共牌、底池、行动者、可见底牌及终局排名展示（TEX-25）。视觉层为白色页面中的深青绿色椭圆牌桌：本人始终位于下方，公共牌与底池居中，其他已入座玩家环绕，操作区以白色悬浮面板呈现。明牌采用项目化的标准扑克样式：真实牌宽高比、四角牌值和花色、2–10 的牌点阵列、A 的居中大花色；底牌则使用蓝色花纹牌背。组件只消费 `ProjectionStore` 的权威 Snapshot/Event/Clock 镜像；私有牌只读取 `viewer.holeCards`，其他玩家只显示已投影公开牌或牌背。

`table-state.ts` 保持为可测的纯展示准入逻辑：没有当前行动、连续投影、有效连接或存在 pending 命令时不展示操作区。它不计算筹码、合法性或胜负。

Showdown 的 canonical target 可以先包含多个已公开 `revealedCards`；Seat 仍只根据 presentation 中已完成的逐人 `PLAYER_REVEALED` 显示对手牌。Snapshot 屏障则直接对齐权威终态，不重放旧 Reveal。

TEX-26 的牌桌将队列 presentation state 仅用于牌、筹码和 Overlay；下注区、倒计时和命令 payload 一律使用最新 canonical Snapshot。物理 Deck 固定在牌桌外左上角的白色留白区，不占用任何玩家手牌或 Board 空间；每张手牌按其已投影的 `DEAL_HOLE_CARD` 读取 Deck 与牌桌的实际 DOM 边界，从同一 Deck 沿 transform/opacity 合成层的浅弧线、保持正向地飞向目标座位。第一、二轮的每张牌背都对全桌可见，第二轮最后一张落定后，本人才将服务端投影的两张牌依次纵轴翻开，其他人始终只有牌背；`cardIndex` 还用于把两轮牌落在手牌区左右两侧。每个 `handId + playerId + cardIndex` 都生成新的飞行组件 key，保证连续发牌不会复用已经结束的 CSS animation。`deal-flight.ts` 只负责这条无规则、无私有牌数据的几何位移和展示实例身份，并有上、侧、下座位、左右落点及逐 Event 重启 Unit 覆盖。公共牌在对应目标框中按“入框 → 停顿 → 翻面”逐张可读地呈现，Soft Catch-up 不会抢先以 canonical Board 替换尚未翻完的第三张；Burn Overlay 没有牌面。Showdown 先摊开服务端公开的底牌，再使七张已公开候选牌中非最佳牌淡出并组合 `PLAYER_REVEALED.handRank.bestFiveCards`，并保留 Best Five 的长阅读停留；前端只比较卡牌身份以展示服务端已判定集合，绝不计算牌型或赢家。牌桌提供音效开关、非阻断重连提示、`EXIT_PENDING`/`WITHDRAWN` 文案及 `SESSION_REPLACED` 的键盘可达阻断对话框。
