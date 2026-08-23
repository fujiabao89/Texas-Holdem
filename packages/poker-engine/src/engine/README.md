# Engine state machine

牌局状态、回合推进、状态转换和规则协调（TEX-14）。

- `state-machine.ts` —— `createInitialState`（选 Dealer、缴盲、发底牌、定首行动者）与 `reduceHand`（校验并应用动作、推进街、提前结算/Runout、比牌与分池结算）——确定性纯转移（规格 §16）。
- `hand-engine.ts` —— `PokerHandEngine` 薄门面：持权威状态与事件日志，`getLegalActions`/`applyAction`/`getState`/`getEvents`/`isComplete`/`getOutcome`。
- `invariants.ts` —— `assertInvariants`（§17 全部不变量）。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §5–§11、§14、§16、§17。
