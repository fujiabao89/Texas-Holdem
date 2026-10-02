# Project documents

项目范围、术语与计划。实现细节应引用而非复制架构文档。

## 依赖维护

- [TEX-63 最小依赖补丁升级与安装验证](https://linear.app/texas-holdem/issue/TEX-63)：用户直接委派 Codex；仅升级必要依赖并保留无关锁定节点，分支 `chore/TEX-63-minimal-dependency-patches`。范围、本地验证与待 CI 验证项见 [验收记录](../03-engineering/dependency-patch-validation.md)；不改变产品路线图。

## P0 执行文档

- [TEX-38 全面优化前端动画与音效体验](https://linear.app/texas-holdem/issue/TEX-38)：在 TEX-26 已交付基础上完善牌桌反馈、声音控制与降级；实现由用户委派 Codex，独立于 TEX-29 压测。规格见 [05 §9.7/§10.3](../05-frontend-spec.md)，交付核对见 [验收记录](../03-engineering/TEX-38-acceptance.md)。

- [P0 任务总览与执行顺序](./p0-task-overview.md)：快速查看 P0 范围、负责人、依赖图和当前开工顺序。
- [P0 任务卡：工程地基与扑克引擎](./p0-foundation-and-engine-tasks.md)：TEX-11 至 TEX-16。
- [P0 任务卡：协议、数据与游戏服务端](./p0-server-and-data-tasks.md)：TEX-17 至 TEX-22。
- [P0 任务卡：Web 前端、验证、部署与发布](./p0-web-and-release-tasks.md)：TEX-23 至 TEX-30，以及 TEX-39 至 TEX-43。

任务的实时状态、评论和依赖以 [Linear 项目](https://linear.app/texas-holdem/project/texas-holdem-70cb976c03d2) 为准；本目录提供稳定的中文任务说明。

- [TEX-44 产品首页与视觉交互升级](https://linear.app/texas-holdem/issue/TEX-44)：用户直接委派 Codex；范围为既有 Web 展示层与产品首页，保留游戏协议和服务端权威边界。分支 `feat/TEX-44-river-and-raise-design`；[验收记录](../03-engineering/TEX-44-acceptance.md)。

- [TEX-45 游戏内牌桌与扑克牌视觉优化](https://linear.app/texas-holdem/issue/TEX-45)：用户直接委派 Codex，仅优化游戏展示，保留动效和音效。基于 TEX-44 已提交版本，分支 `feat/TEX-45-refine-in-game-table-and-cards`；用户追加授权推送并创建 PR，依赖 TEX-44，见 [验收记录](../03-engineering/TEX-45-acceptance.md)。

TEX-54 持久化赛果读取已实现，任务验收与明确非范围见 [TEX-54验收记录](../03-engineering/TEX-54-acceptance.md)。现有前端页面的HTTP恢复接入、暂停手间独立终局写入与旧live撤回筹码投影分别保留为后续事项，不扩大本卡只读范围。

- [TEX-60 修正弱网环境下的倒计时与操作提交公平性](https://linear.app/texas-holdem/issue/TEX-60)：用户直接委派 Codex；分支 fix/TEX-60-network-fair-action-clock，依赖 TEX-58/TEX-59。范围见 [ADR-0006](../adr/0006-tex-60-network-fair-action-clock.md)，[验收记录](../03-engineering/TEX-60-acceptance.md)；不暂停整桌或给单玩家延长时钟，背压/完整门禁由 TEX-61/TEX-62 承担。
