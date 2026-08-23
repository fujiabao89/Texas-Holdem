# Pots

主池、边池、分池和结算分配规则（TEX-14）。

- `layering.ts` —— `buildPots`：按 `handContribution` 分层，先迭代剥离唯一最大贡献者的未跟注部分并退回（不看 fold），再自低层起建 main/side pot（contributors 含 fold、eligible 不含 fold）。
- `settlement.ts` —— `settlePots`：每池独立在 eligible 玩家间用七选五评估比牌，平局 split，Odd Chip 从 Dealer 左侧顺时针给第一个该池受奖赢家。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §9、§10、§17。
