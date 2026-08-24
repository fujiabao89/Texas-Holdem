# Rules

盲注、合法动作、下注、全下、摊牌与锦标赛规则等可单独验证的规则（TEX-14 + TEX-15）。

- `blinds.ts` —— 选 Dealer / 算 SB・BB / 首行动者（Heads-Up 与多人桌）/ 座位顺时针。
- `betting.ts` —— `computeLegalActions`、`isPending`/`anyPending`、`updateAggression`（`lastFullRaiseSize`/`hasFullBetOrRaise`）、`resolveCall`/`resolveBetOrRaise`/`resolveAllIn`（含 Short Call All-in、Short All-in 与下注权重开）。
- `legal-actions.ts` —— `computeLegalActionsForSeat`（Engine 唯一合法动作来源）。
- `street.ts` —— 街推进（`nextStreet`）与发公共牌（`burnAndDeal`，Burn 不携带牌面）。
- `tournament.ts`（TEX-15）—— 唯一配置校验 `validateTournamentConfig`、盲注等级计算 `computeBlindLevelIndex`（固定/按时间/按手数）、`resolveBlindLevel`、后续 Dealer `nextTournamentDealer`、同手淘汰排序 `sortEliminationGroup`。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §5–§8、§11、§12。
