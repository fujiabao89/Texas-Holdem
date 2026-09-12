# ADR-0003：Snapshot 中的权威庄位与盲注座位

- 日期：2026-09-12
- 状态：已采用，TEX-53
- 权威契约：[协议规格](../02-protocol-spec.md) §4.1 / §9.2

## 背景

`HAND_STARTED` 已携带 Engine 裁决的 D/SB/BB 座位，但完整 PlayerView 缺少 SB/BB。重连、缺序重同步与 Fast Forward 不重放开手事件，客户端无法从 Snapshot 恢复盲注标识。根据庄位、筹码或当前活动玩家推算会在 Heads-Up、淘汰、撤回及跨手时产生错误。

## 决定

`PlayerView`、`BotView`、`GameSnapshot` 必填新增 `smallBlindSeat` / `bigBlindSeat`（座位 0–9 或 `null`）；同构 patch 支持可选字段、显式 `null` 清空。两字段直接读取当前 `TournamentState.hand.sbSeat/bbSeat`，无当前手为 `null`；手已结束但仍保留该手时保留本手座位。`dealerSeat` 在有手时读取该手 `dealerSeat`，无手时保留既有 Tournament 庄位语义。所有 Snapshot reason 与逐事件 patch 使用同一投影函数；跨手三个座位随该手一起更新。

这些字段均是公开信息，所有授权玩家、淘汰观战者与 BotView 一致。严格 Schema 要求新字段，因此 wire 主版本从 v3 提升到 v4；前后端同步升级或回滚，v3 及更早版本通过 `UNSUPPORTED_PROTOCOL_VERSION` 拒绝。HTTP 路径仍为 `/api/v1`，wire `snapshotVersion: 1` 保持不变。持久化 Snapshot 已存储 Engine hand 的盲注座位，内部 `schemaVersion/engineVersion` 与 wire 版本独立，无数据库迁移。

## 备选与后果

不采用客户端推算、从最近事件回填或可选字段静默兼容：它们不能保证首帧/恢复结果一致。客户端只增加共享协议字段的消费与夹具，不在本任务增加座位 UI。验证覆盖 2/3/6/10 人、非连续座位、淘汰/撤回、跨手、恢复、Snapshot 原因、公开一致/私有隔离、序列及旧版本拒绝。引擎纯规则与持久化格式不变。
