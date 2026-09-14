# Room / 身份 / Tournament 重启恢复（TEX-51）

权威语义见 [数据模型 §4.3/§7.5](../03-data-model.md)、[服务端架构 §13](../04-game-server-architecture.md) 和 [ADR-0003](../adr/0003-tex-51-room-recovery-authority.md)。只支持模拟筹码、单一 game-server 写者。

## 部署与恢复

1. 停止旧写者，保留 PostgreSQL 与未关闭 Room 使用的 `TOKEN_HMAC_SECRET` / `TOKEN_HMAC_KEY_ID`。不要打印或复制真实令牌。
2. 用既有部署注入的目标 schema 执行 `pnpm --filter @texas-holdem/game-server db:migrate`，确认 `0003_room_revision_reservation` 已提交；应用不自行迁移。
3. 启动服务。监听前完整恢复 Room/成员/最新比赛；总体 DB 读取失败拒绝监听。`restored N room(s)` 与 `recovery isolated room=... tournament=... reason=...` 为安全诊断。
4. 玩家以原 token 重新认证，接受新的 Snapshot 屏障。Lobby 重新入座/准备；进行中比赛从最近已完整提交手末开始下一手，未提交手牌整体舍弃，不进入历史。

## 隔离处置

缺失 Host/成员、未知 key ID、配置冲突、检查点 checksum/版本/事件缺口不得人工猜补。先保留数据库证据，按 ID 在受控数据库会话核查权威表；不要将摘要/牌面写入工单或日志。`superseded-tournament` 表示更高编号已取代旧场，旧场不会恢复发牌。Room FINISHED / 最新 Tournament IN_GAME 的合法写入延迟按可验证根协调。

恢复任一仓储读写发生意外数据库连接、SQL、权限或迁移错误时，以固定 `ROOM_RECOVERY_INFRASTRUCTURE_FAILED:<operation>` 错误中止启动，不将暂时不可用的房间误记为校验隔离；修复基础设施后重新启动。已离开成员在最近检查点仍为 ACTIVE 时保守隔离，待人工处置，这种正常提交时间差不等同于数据损坏。

`ROOM_REVISION_RESERVATION_FAILED` 或运行期号段耗尽时，不得归零 revision。检查迁移、Room 状态和数据库可用性；运行期号段耗尽可受控重启预留下一个号段。达到安全整数总上界时需新的已审查协议/数据决策，不能继续递增。

## 回滚与验证

应用回滚可保留新增兼容列；不要删除已分配上界或手动减小。旧版没有完整恢复/号段保护，回滚后应明确暂停相关可用性承诺，而非混跑两个写者。

隔离测试库设置 `TEX_TEST_DATABASE_URL` 后执行：

```bash
pnpm exec vitest run --project unit apps/game-server/src/persistence/recovery.test.ts apps/game-server/src/persistence/room-recovery.test.ts
pnpm exec vitest run --project integration apps/game-server/tests/integration/room-recovery.test.ts apps/game-server/tests/integration/room-restart.test.ts
```

真实重启测试会创建并删除独立测试 schema、启动/终止测试子进程；不得指向生产库。测试跳过不是验证通过。
