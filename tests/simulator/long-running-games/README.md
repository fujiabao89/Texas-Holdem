# Long-running games

完整 Tournament 长跑运行器与 Liveness/覆盖保障（TEX-16）。

- [tournament-runner.ts](./tournament-runner.ts)：`runTournament(seed)` —— 由 seed 派生场景/引擎随机源/代理随机流，驱动 `TournamentEngine` 到唯一 Champion；每次转移后断言不变量与事件序列，手结束提取结算摘要。任何失败封装为 `SimulationFailure` 并保留完整现场。同 seed 结果完全一致（100% 重放）。
- [watchdog.ts](./watchdog.ts)：Liveness Watchdog——单场 >50,000 action、>30 秒进程时间、或连续 >1,000 次状态转移未完成一手牌即失败（阈值可注入，测试用假时钟，不用 sleep）。
- [stats.ts](./stats.ts)：覆盖统计——玩家数、街、动作类型、牌型、Pot 数量、All-in 人数、Heads-Up、盲注升降、结束原因分布；分层运行的必需类别清单与零覆盖检测。
- [failure.ts](./failure.ts)：失败类别、重放命令、序列化与失败产物写入（`failure-seed<n>-<category>.json`）。
