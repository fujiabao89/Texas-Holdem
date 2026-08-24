# Engine state machine

牌局状态、回合推进、状态转换、规则协调与锦标赛编排（TEX-14 + TEX-15）。

- `state-machine.ts` —— `createInitialState`（选 Dealer、缴盲、发底牌、定首行动者）与 `reduceHand`（校验并应用动作、推进街、提前结算/Runout、比牌与分池结算）；`foldSeatForWithdraw`（撤回折叠，复用 `advanceAfterAction`）——确定性纯转移（规格 §16）。
- `hand-engine.ts` —— `PokerHandEngine` 薄门面：持权威状态与事件日志，`getLegalActions`/`applyAction`/`foldForWithdraw`/`getState`/`getEvents`/`isComplete`/`getOutcome`。
- `invariants.ts` —— `assertInvariants`（手级 §17 全部不变量）。
- `tournament-engine.ts`（TEX-15）—— `TournamentEngine`：初始筹码、首手/后续 Hand（经 `PokerHandEngine` 公开接口）、Blind Level、Dealer 轮转、淘汰、排名、Heads-Up 切换、唯一冠军与锦标赛事件；`withdrawParticipant`（独立撤回指令）。
- `tournament-invariants.ts`（TEX-15）—— `assertTournamentInvariants`（筹码守恒含 `forfeitedChips`、非负筹码、淘汰/撤回不可行动、唯一冠军）。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §5–§14、§16、§17。
