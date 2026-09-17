# Schemas

共享通用字段、Snapshot/View 和投影的运行时校验。`projection.ts` 只接收明确列出的最小服务端源字段，并以 allow-list 重建 PlayerView/BotView；不会展开或透传内部状态。

`common.ts` 的 `PROTOCOL_VERSION` 是客户端、服务端和测试夹具共同使用的版本来源；TEX-36 提升到 v3，TEX-53 提升到 v4，TEX-58 再提升到 v5，兼容策略见协议规格 §4.1 / ADR-0002 / ADR-0005。完整 PlayerView/BotView/GameSnapshot 必填 smallBlindSeat/bigBlindSeat 与 showdownDisplayUntil，patch 支持可选与 null 清空；最小源模型与 allow-list 投影同步这些公开字段。

TEX-54：`http.ts` 增加持久化赛果 GET 的严格 UUID 参数、空查询、成功信封与推导类型；`views.ts` 导出既有 `RankingViewSchema` 供 HTTP 与 WS 复用。结果校验冠军、身份、并列组完整性、展示序、撤回无排名与安全筹码，详见 [02](../../../../docs/02-protocol-spec.md) 的 TEX-54 小节。

TEX-58：`common.ts` 的 `HandPhaseSchema` 新增 `"SHOWDOWN_DISPLAY"` 阶段；`views.ts` 增加 `showdownDisplayUntil`（可为 null）并添加跨字段严格校验（`validateShowdownAndClockInvariants`），确保展示阶段与行动权/倒计时严格互斥。wire 主版本提升至 v5。
