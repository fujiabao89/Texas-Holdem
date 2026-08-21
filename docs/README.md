# 工程文档总索引

> 状态：草稿
> 更新：2026-08-21

本目录是工程文档的唯一入口。规范：**一个事实只有一个权威来源**，其他文档链接引用而不是重写；产品层文档（规划书）留在仓库根目录，在本索引链接并标注"产品意图，非实现事实"。

> 项目现状：尚无代码（2026-08-21 核对）。`packages/`、`apps/`、`tests/` 均未创建，本文档体系内的工程文档均为**设计意图 · 未实现**。

## 文档地图

| 编号 | 路径 | 一句话目的 | 权威范围 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | [01-engine-spec.md](./01-engine-spec.md) | Poker Engine 纯规则规格 | 牌堆与发牌、下注与最小加注、Pot/Side Pot/Split、Hand 状态机、Hand Evaluator、Tournament 淘汰与排名、Game Events、RNG 与 Engine Invariants | 草稿（设计意图 · 未实现） |
| 02 | [02-protocol-spec.md](./02-protocol-spec.md) | 联机协议规格（`packages/protocol`） | HTTP/WS 通道分工、身份与凭证、消息信封与 Snapshot + Event Stream、sequence 与幂等（actionId/expectedSequence/receivedAt）、超时竞争裁决、消息目录、PlayerView/BotView 投影契约、ErrorCode 码表 | P0 可实施基线（设计意图 · 未实现） |
| 03 | [03-data-model.md](./03-data-model.md) | 数据模型与持久化规格（`apps/game-server` / Supabase Postgres） | 内存 vs 持久化边界、核心表（rooms/tournaments/tournament_players/hands/hand_events/game_snapshots/ai_requests）字段与约束、写入节奏与失败语义、敏感数据存放与暴露规则 | 草稿（设计意图 · 未实现） |
| 04 | [04-game-server-architecture.md](./04-game-server-architecture.md) | Game Server 运行时工程设计（`apps/game-server`） | Room/Tournament 运行时、单桌串行执行器与超时裁决、Scheduler/Timer、连接管理与接管、投影执行、持久化编排、崩溃恢复、无真人关房、P1 AI 接入点 | 草稿（设计意图 · 未实现） |
| 05 | [05-frontend-spec.md](./05-frontend-spec.md) | Web 前端工程设计（`apps/web`） | 页面与路由、客户端状态与投影消费、横向 Seat 牌桌与响应式、下注交互（快捷下注/Slider/±/精确输入/All-in 两步/Time Bank）、AnimationQueue 与事件动画、音效、计时与重连 UX、错误码展示、Lobby 流程、观战/赛果/Hand History UI、可访问性与验收标准 | 草稿（设计意图 · 未实现） |
| 06 | [06-testing-strategy.md](./06-testing-strategy.md) | 测试方案与发布门槛（`tests/`） | 测试分层与归属、P0 必测范围矩阵、Invariant 自动断言、Headless Simulator、联机/重连/投影安全测试范围、P1 AI 测试、UI E2E 与人工验收组织、性能与监控指标、CI 分层与门禁、缺陷分级与发布门槛 | 草稿（设计意图 · 未实现） |
| 07 | [../DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md](../DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md) | DeepSeek Harness 提交前本地审查 Agent 创建提示词 | 只读审查范围、严重性、验证策略、输出契约与提交/推送门禁 | 治理基线 |
| 项目执行 | [00-project/README.md](./00-project/README.md) | P0 中文任务卡与执行顺序 | TEX-11 至 TEX-30 的负责人、前置依赖、范围、验收与权威规格引用 | 已规划，未实现 |

## 产品层文档（非实现事实）

| 文档 | 版本 · 日期 | 说明 |
| --- | --- | --- |
| [德州扑克项目总规划.md](../德州扑克项目总规划.md) | v1.0 · 2026-08-20 | 权威产品与技术规划，已合并区块 1–10 与本轮决策 |
| `德州扑克项目规划_区块1-5_v0.1.docx` | v0.1 · 2026-08-20 | 产品与体验规划；部分条款已被总规划取代（清单见 01 §21） |
| `德州扑克项目规划_区块6-10_v0.2.docx` | v0.2 · 2026-08-20 | 技术与交付规划；部分条款已被总规划取代（清单见 01 §21） |

## 阅读路径

- **实现 Poker Engine**：读 [01-engine-spec.md](./01-engine-spec.md) 全文；配套读《总规划》§2/§9（规则决策与测试门槛）。
- **实现联机/协议层**：读 [02-protocol-spec.md](./02-protocol-spec.md) 全文；规则语义引用 01 §5/§13/§14；配套读《总规划》§3–§5。
- **实现持久化层**：读 [03-data-model.md](./03-data-model.md) 全文；内存状态域引用 01 §4，投影与日志字段引用 02 §9/§11；配套读《总规划》§6。
- **实现 Game Server**：读 [04-game-server-architecture.md](./04-game-server-architecture.md) 全文；规则语义引用 01 §5/§13/§14，wire 契约引用 02 §4–§11，持久化引用 03；配套读《总规划》§3–§5。
- **实现 Web 前端**：读 [05-frontend-spec.md](./05-frontend-spec.md) 全文；wire 契约与投影引用 02 §4–§11，规则语义与事件目录引用 01 §5.2/§6/§14，服务端计时与推送引用 04 §8/§9；配套读《总规划》§7。
- **搭建测试体系**：读 [06-testing-strategy.md](./06-testing-strategy.md) 全文；规则测试范围引用 01 §5–§17，联机测试引用 02 §9/§12/§14 与 04 §5–§9，前端验收引用 05 §16；配套读《总规划》§9。
- **执行 P0 任务**：先读 [P0 任务总览](./00-project/p0-task-overview.md)，再进入对应阶段任务卡；实现事实仍以 01–06 工程规格和 Linear 任务为准。
- **提交或推送本地实现前**：使用 [DeepSeek Harness 审查 Agent 创建提示词](../DEEPSEEKHARNESS_REVIEW_AGENT_PROMPT.md) 创建并调用只读审查 Agent；Claude Code 与 Trae Work 的门禁规则见 `CLAUDE.md`、`TRAE.md`。
- **规划文档体系**：见下方"待确认"。

## 待确认

- **编号体系**：`01-` 前缀编号源自用户命名，后续文档沿用 `NN-<topic>.md`。编号 04 `game-server`、05 `frontend`、06 `testing`（测试方案，均已创建）。编号 07 及以后未规划，候选主题（未确认，勿据此开工）：`architecture`（系统架构）。
- **文档体系方案**：建议在开工下一个模块前，按 P0/P1/P2 一次性确认完整文档清单（Skill 要求大任务先出方案）。
