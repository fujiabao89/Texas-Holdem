# Simulations

长时间、随机化和基于不变量的扑克引擎验证（TEX-12 入口，TEX-16 落地长跑主循环）；不依赖真实网络和数据库。权威规格：[docs/06-testing-strategy.md](../../docs/06-testing-strategy.md) §4/§5。

## 入口

```bash
pnpm test:sim -- --seed 20260821              # 单 seed 批次（默认 32 场；seed 即第 1 场）
pnpm test:sim -- --seed 20260821 --games 100  # 指定批次数
pnpm test:sim -- --tier smoke --sha <hex>     # PR Smoke：已知失败 seed + SHA 派生 ≥200 场
pnpm test:sim -- --tier nightly --sha <hex>   # Nightly：SHA 派生 ≥10,000 场
pnpm test:sim -- --tier rc --sha <hex> --ledger <file>   # RC：累计 ≥50,000、fresh ≥10,000
```

- 入口：[run.ts](./run.ts)（独立 Node CLI，经 tsx 运行）。Seed 解析复用 [tests/support/seed.ts](../support/seed.ts)，`--seed` 优先于环境变量 `TEX_TEST_SEED`；`--sha` 可由环境变量 `TEX_SIM_SHA` / `GITHUB_SHA` 提供；`--out <dir>` 指定产物目录（默认 `tests/simulator/.artifacts/`，已 gitignore）。
- **真正运行 TournamentEngine**：每场从 `random-hands` 场景构建锦标赛配置，代理只从 Engine `LegalActions` 选择动作（[agent.ts](./random-hands/agent.ts)），驱动到唯一 Champion。

## 三档规模（docs/06 §5）

| 档位 | 场次 | 运行位置 |
| --- | --- | --- |
| Smoke | 已知失败 seed 回归集（[known-seeds.ts](./known-seeds.ts)，当前为空）+ 从提交 SHA 确定性派生 ≥200 个新 seed | PR CI（`.github/workflows/ci.yml` 的 quality job） |
| Nightly | 同一提交 SHA 确定性派生 ≥10,000 场 | `schedule`（每日 02:00 北京时间）或 `workflow_dispatch`（`.github/workflows/simulator.yml`），不进普通 PR CI |
| RC | 累计 ≥50,000 场，其中 ≥10,000 个此前未运行 seed；依赖 `--ledger` 台账（JSON，记录各 SHA 已运行 seed） | 本地/受控环境手动运行；台账证明 fresh 配额 |

Nightly/RC 等大规模运行不得塞进普通 PR CI；如需 CI 触发，只使用 `schedule` / `workflow_dispatch` 或显式参数。

**运行报告与 Artifact（已裁决 2026-08-24）**：Nightly 经 GitHub Actions 定时任务上传 JSON Artifact（`simulator-nightly-<sha>` / `simulator-<tier>-<sha>`），内含提交 SHA、tier、seed 范围、覆盖统计与失败现场的 `summary.json` / `failure-*.json`；RC 将同类报告绑定候选提交保存。失败 seed 的最小 fixture（场景配置 + seed）可版本化纳入 [known-seeds.ts](./known-seeds.ts) 回归集；普通运行报告只存 Artifact，不提交仓库。

## 场景加权策略（已裁决 2026-08-24）

- 初始加权为**明确冻结值**：玩家数 2/3/10 各权重 3、4–9 各 1；筹码深度 浅/中/深 = 3/2/3；盲注模式 fixed/hands/time = 2/3/2；代理风格 aggressive/balanced/cautious/folding = 3/2/1/1；`folding × 深筹码` 禁止（防数千手盲注磨牌，深筹码覆盖由其余风格承担）。每次运行输出完整覆盖分布（`coverage` 统计）。
- 调整规则：在**至少连续 3 次 Nightly 数据**后，依据实际覆盖缺口调整权重；调整时在本节记录原因与调整前后数据。首个调整窗口之前的任何权重变化都需重新裁决。

## 可复现性与失败产物

- 每场的 `randomSeed` 即该场 seed：场景、引擎洗牌/首手 Dealer（`SeededRandomSource`）与代理决策全部由 seed 派生，同 seed 100% 重放（docs/01 §16）。
- 失败时（不变量违反 / 引擎错误 / Watchdog / 覆盖空洞）：
  - 控制台输出失败类别、原因、**重放命令**（`pnpm test:sim -- --seed <n> --games 1`）与场景摘要；
  - 失败产物目录写入 `failure-seed<n>-<category>.json`：类别、seed、最小场景 fixture（players/stack/blind 结构/风格）、完整 Action/Event 轨迹、失败时状态与统计摘要；
  - 退出码非 0。成功运行只在产物目录保存聚合统计 `summary.json`，不输出逐场细节。
- 每次状态转移后与每手结束后断言全部引擎不变量（复用 `packages/poker-engine` 的 `assertInvariants` / `assertTournamentInvariants`）与主事件流 sequence 连续性（[invariants/](./invariants)）。
- Watchdog（[watchdog.ts](./long-running-games/watchdog.ts)）：单场 >50,000 action、>30 秒进程时间，或连续 >1,000 次状态转移未完成一手牌，按 Liveness Failure 失败并保留现场。
- 分层运行结束时检查覆盖类别（玩家数 2/3/10、深浅筹码、三种盲注模式、盲注升降、街/摊牌/Fold 结束、Side Pot、多人 All-in、Heads-Up、全部动作类型）：某类为零即生成器覆盖失败，退出码非 0。

## 目录

| 目录/文件 | 职责 |
| --- | --- |
| [run.ts](./run.ts) | CLI 入口：参数解析、档位规划、批处理循环、摘要/失败产物输出 |
| [tiers.ts](./tiers.ts) | Smoke/Nightly/RC 种子规划与 SHA 派生（FNV-1a 纯函数） |
| [known-seeds.ts](./known-seeds.ts) | 已知失败 seed 回归集（当前为空，随首个失败回填） |
| [random-hands/](./random-hands) | 加权场景生成与 LegalActions 代理 |
| [invariants/](./invariants) | 引擎不变量与事件序列断言 |
| [long-running-games/](./long-running-games) | 单场运行器、Watchdog、覆盖统计、失败报告 |

模拟器模块的 Vitest 测试（`*.test.ts`）归属 unit 层（根 `pnpm test:unit`，见 [tests/README.md](../README.md)）。
