# Invariants

引擎不变量与事件序列完整性断言（TEX-16）。

- [invariant-checks.ts](./invariant-checks.ts)：`assertTournamentStateInvariants` 复用引擎导出的权威实现（手级 `assertInvariants` + 锦标赛级 `assertTournamentInvariants`，docs/01 §17），由 runner 在每个合法状态转移后与每手结束后调用；`createEventSequenceChecker` 断言主事件流 `sequence` 严格 +1 递增无缺口。本模块不定义新不变量，不复制规则判断。
