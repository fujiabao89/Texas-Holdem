# ADR-0004：TEX-54 持久化赛果读取

- 日期：2026-09-12
- 状态：已批准（Codex 架构审阅）

## 背景

赛果当前依赖存活的 WebSocket/Runtime。数据库 `tournament_players.rank` 是并列组内打破并列后的唯一展示序，不能据此重建并列范围。既有终局 Snapshot 保存引擎 `finalStandings`，其中包含权威范围与组内顺序。

## 决策

新增 `GET /api/v1/tournaments/{tournamentId}/result` 与共享严格 HTTP Schema。读取在单个 PostgreSQL REPEATABLE READ、READ ONLY 事务内完成；授权只接受所属未关闭 Room 的 ACTIVE HUMAN 成员 Bearer 凭证，不要求曾参加该场比赛。该接口只包含公开赛果，允许同房间后加入成员访问；Hand History 的参赛者限制保持原契约。

仅 `FINISHED` 且终局记录完整可成功。Snapshot 版本、checksum、序列水位、终局边界、锁定参赛者、冠军、结果列和最终排名相互校验；并列范围来自 `finalStandings`，绝不由 rank 推测。撤回者出现在 players 中但没有虚构名次。无冠军终局继续接受 ADR-0002 的合法表示。

新增 HTTP 错误 `TOURNAMENT_NOT_FOUND`（404，含到期）、`TOURNAMENT_NOT_FINISHED`（409，运行中或 ABANDONED）、`TOURNAMENT_RESULT_INCOMPLETE`（503、可重试）。身份错误沿用 401。成功与失败均 `Cache-Control: no-store`。请求无查询参数，Token 只在 Authorization；日志只保留既有无身份标签的聚合 HTTP 指标，不记录请求/响应/异常本体。到 `retention_expires_at` 即返回 404，即使清理延迟，不延长保留期、不新增清理任务。

## 备选与后果

不使用内存恢复作为赛果读取的前置条件，不新增复制赛果表或迁移。以严格白名单从私有 Snapshot 提取公开信息，原始 Snapshot、牌面、内部参赛 ID、凭证和事件不出服务端。读失败只影响此次 HTTP 请求，不能修改 Runtime、Writer 或持久化状态。

新增 HTTP 接口不改变既有 WebSocket 主版本，以共享 `PROTOCOL_VERSION` / 02 §4.1 为准；客户端恢复页面属于后续任务。权威接口、数据与运行契约分别见 02、03、04；验收见 06 与 TEX-54 验收记录。
