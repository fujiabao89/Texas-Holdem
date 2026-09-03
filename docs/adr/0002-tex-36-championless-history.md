# ADR-0002：Hand History 的无冠军终局表示

- 日期：2026-09-03
- 状态：已采用，随 TEX-36 / PR #30 交付
- 权威契约：[协议规格](../02-protocol-spec.md) §4.1 / §8.3

## 背景

TEX-36 原任务不计划修改公共 Schema。PR #30 审查验证发现一个必须兼容的既有 Engine 结果：先有真人被淘汰并留房观战，最后两名活动玩家在同一手撤回，运行时提交 `FINISHED`（Room 未关闭）与 `championSeat: null`。该观战者仍持有效凭证，但现有投影输出空字符串，详情 Schema 拒绝后返回 500。真实 TournamentExecutor → Commit Bundle → PostgreSQL → HTTP 集成测试已复现。

## 决定

只扩展 `TOURNAMENT_FINISHED` 的既有结果表示：`winnerPlayerId` 为 `string | null`，`null` 明确表示无冠军；无冠军时 `rankings` 可为空或仅含已产生的淘汰名次。有冠军时仍要求非空 ID 与至少一项排名。禁止用空字符串、虚构冠军或丢弃终局事件掩盖该状态。Hand History 展示“比赛结束，无冠军”。不改变 Engine 规则、排名或持久化写入。

旧 v2 客户端不能解析 `null`，因此 wire 主版本提升到 v3，HTTP 路径保持 `/api/v1`。客户端与服务端须同时发布；旧版本连接按现有 `UNSUPPORTED_PROTOCOL_VERSION` 路径拒绝。无数据库迁移。此处是原任务 Schema 非范围的最小必要例外，仅用于关闭已经复现的 PR 阻塞项。

## 验证与后果

验证无冠军空排名、无冠军有淘汰排名、有冠军正常排名、空字符串拒绝、旧版本拒绝，并以真实运行时/数据库路径验证有效观战者读取最后一手。同步共享 Schema、服务端投影、前端文案和协议测试夹具。回滚时客户端与服务端必须同时回滚，避免主版本不匹配。
