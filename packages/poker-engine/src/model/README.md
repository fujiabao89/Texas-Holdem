# Model

纯领域类型层（TEX-14）。只含 TypeScript 类型与枚举常量，零运行时依赖；供 `rules/`、`pots/`、`events/`、`engine/` 共同引用，从而打破「engine ↔ rules」的循环依赖。

- `type.ts` —— `Street` / `HandPhase` / `ActionType` / `ActionSource` / `ParticipantKind`。
- `action.ts` —— `PlayerAction`（金额语义：`betTo` / `raiseTo` 为本街目标总投入）。
- `legal.ts` —— `LegalActions`（Engine 唯一合法动作来源）。
- `player.ts` —— `PlayerState`（`streetBet` / `handContribution` / 权重开记录）。
- `pot.ts` —— `Pot` / `PotAward`（contributors 与 eligiblePlayers 分离）。
- `hand.ts` —— `SeatConfig` / `HandConfig` / `GameState` / `HandOutcome`。

权威规则见 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md) §4/§5/§6/§9/§17。
