# Poker table feature

牌桌状态投影、2–10 Seat 布局、公共牌、底池、行动者、可见底牌及终局排名展示（TEX-25）。视觉层为白色页面中的深青绿色椭圆牌桌：本人始终位于下方，公共牌与底池居中，其他已入座玩家环绕，操作区以白色悬浮面板呈现。明牌采用项目化的标准扑克样式：真实牌宽高比、四角牌值和花色、2–10 的牌点阵列、A 的居中大花色；底牌则使用蓝色花纹牌背。组件只消费 `ProjectionStore` 的权威 Snapshot/Event/Clock 镜像；私有牌只读取 `viewer.holeCards`，其他玩家只显示已投影公开牌或牌背。

`table-state.ts` 保持为可测的纯展示准入逻辑：没有当前行动、连续投影、有效连接或存在 pending 命令时不展示操作区。它不计算筹码、合法性或胜负。

TEX-26 的牌桌将队列 presentation state 仅用于牌、筹码和 Overlay；下注区、倒计时和命令 payload 一律使用最新 canonical Snapshot。Burn Overlay 没有牌面；Showdown 的 `bestFiveCards` 只读取服务端 `PLAYER_REVEALED.handRank` 公开字段。牌桌提供音效开关、非阻断重连提示、`EXIT_PENDING`/`WITHDRAWN` 文案及 `SESSION_REPLACED` 的键盘可达阻断对话框。
