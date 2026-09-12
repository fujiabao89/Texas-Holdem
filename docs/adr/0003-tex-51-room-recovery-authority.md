# ADR-0003：Room、身份与 Tournament 的一致恢复

- 日期：2026-09-12
- 状态：采用，TEX-51 实施中
- 权威契约：[数据模型](../03-data-model.md) §4.3 / §7.5、[服务端架构](../04-game-server-architecture.md) §13

## 背景

仅注册 Tournament 无法让旧 playerToken 找到 Room。Room 元数据、异步手末提交与仅驻留内存的 Lobby 字段也不能当作一个同步快照使用。恢复必须先验证整条身份与牌局链，再对外开放。

## 决定

启动屏障内以一致读取得非 CLOSED Room、ACTIVE 成员、Tournament 历史最大编号及锁定参赛者。仅加载摘要，不重签 token、不恢复 LEFT 成员。保留仍是 ACTIVE HUMAN 的持久 Host；Host 缺失、配置非法或凭证 key ID 不受当前配置支持时隔离该 Room，不猜测身份。所有成员恢复为 DISCONNECTED、未准备；LOBBY 座位没有持久化，恢复为 null。比赛座位来自锁定参赛者，扑克状态来自验证通过的手末检查点。

每个 Room 只选择最大 tournamentNo 的一场。较旧且仍标记 IN_GAME 的场次不再注册并单独诊断，避免延迟终局 Bundle 使旧场复活。最新 IN_GAME 可与 Room FINISHED 同时出现（控制面先于 Writer 提交），恢复时将 Room 持久状态协调回 IN_GAME；反向已提交终局则恢复 FINISHED Room，不重启终局比赛。其他不一致拒绝恢复。校验完毕后先注册 Room，再等待 Tournament 恢复启动成功；失败撤销本次注册，不开放半恢复房间。重复恢复不覆盖已存在运行时。

`roomRevision` 继续保持同 Room 跨重启单调，而不是用时间戳近似或归零。新增 `rooms.room_revision_ceiling` 持久化号段上界，默认 `2^32-1`；新 Room 从 1 递增。每次恢复通过原子 UPDATE 预留下一个 `2^32` 大小的号段，丢弃上次未使用部分。运行时在迁移前检查新 revision 不超过所持上界，耗尽则拒绝变更，重启后申请新号段；持久上界不超过 JavaScript 安全整数。预留失败不注册 Room。这样不增加每个 Ready/连接事件的数据库依赖，也不改变 wire 十进制字符串契约。

仍只恢复整手提交边界。进行中手牌、动作、旧连接 epoch 和 Timer 回调不恢复；新认证 Snapshot 为客户端重建屏障，Game sequence 可回到已提交水位。日志只含 Room/Tournament ID 与固定原因码，禁止输出 token、摘要、配置或快照内容。

## 后果与验证

部署前执行新增迁移；回滚应用可保留该兼容字段，但不得回滚为不遵守号段上界的长期运行版本后又声称 revision 严格单调。稳定 HMAC 配置是原凭证继续有效的前提；本次不引入密钥轮换系统。恢复本身不是跨进程多主容错，仍要求单一 game-server 写者。

验证真实 PostgreSQL 与两个真实 WS 客户端：整手提交后杀进程、原数据库重启、原 token 认证、隐私投影、继续提交下一手；另覆盖 Lobby 重置、损坏隔离、回退、缺成员、旧场、重复恢复与 revision 号段预留/耗尽。
