# Timer domain

行动时限和时间银行的纯领域模型（TEX-15）。实际调度器、倒计时与超时 Auto Check/Fold 在 game-server 中。

- `action-timer.ts` —— `ActionTime`（15/20/30/45/60 秒或 `UNLIMITED`，默认 30）、`TimeBankSeconds`（0/30/60/120 秒，默认 60）、`ACTION_TIME_SECONDS`/`TIME_BANK_SECONDS`、`validateActionTimerConfig`（`UNLIMITED` 时 `timeBank` 必须为 0）、`TimeBankState` + `consumeTimeBank`（单次最多扣减 30 秒且每个行动机会最多成功一次）+ `resetTimeBankOpportunity`。

权威规则见 [docs/01-engine-spec.md](../../../docs/01-engine-spec.md) §12、§13、§20。
