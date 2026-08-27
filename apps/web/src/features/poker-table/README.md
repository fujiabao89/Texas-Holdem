# Poker table feature

牌桌状态投影、2–10 Seat 布局、公共牌、底池、行动者、可见底牌及终局排名展示（TEX-25）。视觉层为白色页面中的深青绿色椭圆牌桌：本人始终位于下方，公共牌与底池居中，其他已入座玩家环绕，操作区以白色悬浮面板呈现。明牌采用项目化的标准扑克样式：真实牌宽高比、四角牌值和花色、2–10 的牌点阵列、A 的居中大花色；底牌则使用蓝色花纹牌背。组件只消费 `ProjectionStore` 的权威 Snapshot/Event/Clock 镜像；私有牌只读取 `viewer.holeCards`，其他玩家只显示已投影公开牌或牌背。

`table-state.ts` 保持为可测的纯展示准入逻辑：没有当前行动、连续投影、有效连接或存在 pending 命令时不展示操作区。它不计算筹码、合法性或胜负。

TEX-26 的牌桌将队列 presentation state 仅用于牌、筹码和 Overlay；下注区、倒计时和命令 payload 一律使用最新 canonical Snapshot。牌桌中央下方持续呈现物理 Deck；每张手牌按其已投影的 `DEAL_HOLE_CARD` 从同一 Deck 沿 transform/opacity 合成层轨迹飞向目标座位，本人的投影牌面到位后翻开，其他人始终只有牌背。`deal-flight.ts` 只负责这条无规则、无私有牌数据的几何位移，并有上、侧、下座位 Unit 覆盖。公共牌在对应目标框中按“入框 → 停顿 → 翻面”逐张可读地呈现，Soft Catch-up 不会抢先以 canonical Board 替换尚未翻完的第三张；Burn Overlay 没有牌面。Showdown 先摊开服务端公开的底牌，再使七张已公开候选牌中非最佳牌淡出并组合 `PLAYER_REVEALED.handRank.bestFiveCards`，并保留 Best Five 的长阅读停留；前端只比较卡牌身份以展示服务端已判定集合，绝不计算牌型或赢家。牌桌提供音效开关、非阻断重连提示、`EXIT_PENDING`/`WITHDRAWN` 文案及 `SESSION_REPLACED` 的键盘可达阻断对话框。
