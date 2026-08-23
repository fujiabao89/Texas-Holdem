# Rules

盲注、合法动作、下注、全下和摊牌等可单独验证的规则（TEX-14）。

- `blinds.ts` —— 选 Dealer / 算 SB・BB / 首行动者（Heads-Up 与多人桌）/ 座位顺时针。
- `betting.ts` —— `computeLegalActions`、`isPending`/`anyPending`、`updateAggression`（`lastFullRaiseSize`/`hasFullBetOrRaise`）、`resolveCall`/`resolveBetOrRaise`/`resolveAllIn`（含 Short Call All-in、Short All-in 与下注权重开）。
- `legal-actions.ts` —— `computeLegalActionsForSeat`（Engine 唯一合法动作来源）。
- `street.ts` —— 街推进（`nextStreet`）与发公共牌（`burnAndDeal`，Burn 不携带牌面）。

权威规则见 [docs/01-engine-spec.md](../../../../docs/01-engine-spec.md) §5–§8、§11。
