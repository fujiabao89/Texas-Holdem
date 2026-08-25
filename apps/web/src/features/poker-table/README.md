# Poker table feature

牌桌状态投影、2–10 Seat 布局、公共牌、底池、行动者、可见底牌及终局排名展示（TEX-25）。组件只消费 `ProjectionStore` 的权威 Snapshot/Event/Clock 镜像；私有牌只读取 `viewer.holeCards`，其他玩家只显示已投影公开牌或牌背。

`table-state.ts` 保持为可测的纯展示准入逻辑：没有当前行动、连续投影、有效连接或存在 pending 命令时不展示操作区。它不计算筹码、合法性或胜负。
