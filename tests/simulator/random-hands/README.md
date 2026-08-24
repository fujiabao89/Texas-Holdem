# Random hands

随机牌局生成与 LegalActions 动作选择（TEX-16）。

- [scenario.ts](./scenario.ts)：加权场景生成——玩家数（2/3/10 加权）、筹码深度（浅/中/深）、盲注模式（fixed/hands/time，hands/time 结构强制同时含上升与下降等级）、代理风格（aggressive/balanced/cautious/folding）。folding 风格只配浅筹码（深筹码弃牌磨牌低信号且高耗时）。全部随机性来自注入的 `SeededRandom`；生成结果经 `validateTournamentConfig` 防御校验。
- [agent.ts](./agent.ts)：模拟代理——只从 Engine `LegalActions` 选择动作（不在测试端推断或裁决规则）；`bet`/`raise` 金额恒在 Engine 给出的 `[min, max]` 区间内。
