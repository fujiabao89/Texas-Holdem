# P0 任务卡：工程地基与扑克引擎

> 覆盖 Linear TEX-11 至 TEX-16。先完成本文件的依赖链，才进入协议和联机实现。

## TEX-11：工程地基

- **Linear / 分支**：[TEX-11](https://linear.app/texas-holdem/issue/TEX-11/choretex-11-bootstrap-monorepo-and-quality-baseline) · `chore/TEX-11-bootstrap-monorepo-and-quality-baseline`
- **主责**：Claude Code
- **前置**：TEX-10 仓库治理基线完成。
- **要做什么**：初始化实际需要的 pnpm workspace、Turbo、TypeScript、质量命令、环境样例，以及 apps、packages、tests 的最小可运行目录。
- **不要做什么**：不提前实现 AI、账号、支付、聊天或没有验收价值的空包。
- **完成标准**：干净检出后能安装依赖并运行 lint、typecheck、build 和空测试；目录职责与工程规格一致。
- **权威参考**：《德州扑克项目总规划》§6；`docs/README.md`；`AGENTS.md`。

## TEX-12：测试地基

- **Linear / 分支**：[TEX-12](https://linear.app/texas-holdem/issue/TEX-12/testtex-12-establish-test-infrastructure-and-fixtures) · `test/TEX-12-establish-test-infrastructure-and-fixtures`
- **主责**：Trae Work
- **前置**：TEX-11。
- **要做什么**：建立单测、集成、E2E 的运行入口；提供固定 Seed、假时钟、Fixture、测试数据库隔离和失败产物。
- **不要做什么**：不修改扑克规则或协议语义；不依赖真实密钥和外部网络。
- **完成标准**：相同 Seed 可重复，测试可并行且彼此隔离，CI 可按测试层分别调用。
- **权威参考**：`docs/06-testing-strategy.md` §2、§3、§11。

## TEX-13：扑克牌与牌型

- **Linear / 分支**：[TEX-13](https://linear.app/texas-holdem/issue/TEX-13/feattex-13-implement-cards-deck-and-hand-evaluator) · `feat/TEX-13-implement-cards-deck-and-hand-evaluator`
- **主责**：Claude Code
- **前置**：TEX-12。
- **要做什么**：实现 Card、52 张 Deck、生产安全随机源、可复现测试随机源，以及七选五牌型评估。
- **关键点**：全部牌型、Kicker、A2345 顺子、公共牌成牌、可排序比较键和 `bestFiveCards`。
- **完成标准**：无重复/缺失牌；所有比较边界有测试；生产与测试随机性清晰隔离。
- **权威参考**：`docs/01-engine-spec.md` §7、§10、§15、§17。

## TEX-14：单局扑克规则

- **Linear / 分支**：[TEX-14](https://linear.app/texas-holdem/issue/TEX-14/feattex-14-implement-no-limit-hand-engine-and-pot-settlement) · `feat/TEX-14-implement-no-limit-hand-engine-and-pot-settlement`
- **主责**：Claude Code
- **前置**：TEX-13。
- **要做什么**：实现单手状态机、盲注、发牌、下注、弃牌、全下、边池、分池与 Odd Chip。
- **关键点**：`LegalActions` 是唯一的合法动作来源；处理最小加注、Short All-in、下注权重开与未跟注返还。
- **完成标准**：非法 Action 不改变状态；任意 Side Pot 和 Split Pot 结算正确；面向用户的 Burn 事件不带牌面。
- **权威参考**：`docs/01-engine-spec.md` §5～§11、§14、§17。

## TEX-15：整场比赛规则

- **Linear / 分支**：[TEX-15](https://linear.app/texas-holdem/issue/TEX-15/feattex-15-implement-tournament-engine-and-game-events) · `feat/TEX-15-implement-tournament-engine-and-game-events`
- **主责**：Claude Code
- **前置**：TEX-14。
- **要做什么**：实现 Freezeout Tournament、盲注结构、Hand 间淘汰、排名、冠军、退出和事件。
- **关键点**：盲注只在 Hand 之间变更；允许下降盲注；`WITHDRAWN` 的未投入筹码写入 `forfeitedChips`。
- **完成标准**：配置校验只在 Engine；淘汰、退出、冠军与筹码守恒都可自动断言。
- **权威参考**：`docs/01-engine-spec.md` §12～§17；《德州扑克项目总规划》§2～§4。

## TEX-16：引擎回归与模拟

- **Linear / 分支**：[TEX-16](https://linear.app/texas-holdem/issue/TEX-16/testtex-16-build-engine-regression-and-simulation-suite) · `test/TEX-16-build-engine-regression-and-simulation-suite`
- **主责**：Trae Work
- **前置**：TEX-15。
- **要做什么**：将高风险规则固化为回归测试，并构建可复现的 Headless Simulator。
- **关键点**：覆盖 2/3/10 人、深浅筹码、多人 All-in、Heads-Up、升降盲；失败需保留 Seed 与最小 Fixture。
- **完成标准**：PR Smoke 至少 200 个确定性 Seed，Nightly 至少 10,000 局，RC 至少 50,000 局；死锁由 Watchdog 捕获。
- **权威参考**：`docs/06-testing-strategy.md` §3.1、§4、§5、§12。
