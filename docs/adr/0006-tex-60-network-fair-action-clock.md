# ADR-0006：弱网校时与操作安全余量

- 日期：2026-10-02
- 状态：采用；TEX-60（用户直接委派 Codex 实现）

## 背景与备选方案

收到消息后直接从 `serverTime` 开始计时遗漏传输延迟，组件挂载时才记录锚点还会遗漏渲染延迟。仅修补单向锚点不能估算 RTT；给慢客户端延长截止时间或等待其 ACK 会改变同桌公平性，因此不采用。

## 决策

升级 wire 至 v6，新增认证后的 `TIME_SYNC` / `TIME_SYNC_RESULT`，保留 WebSocket 原生 15/45 秒心跳。客户端发送 `requestId + clientSentAt`（本地单调毫秒，允许小数），网关通过 Schema 后立即记录 `serverReceivedAt`，回包记录 `serverSentAt` 并原样回显请求。该路径不进入桌队列、不写持久化、不推进 sequence、不改 deadline。服务端只信任自己的接收时间，客户端时间戳只用于回显。

客户端认证/重连后立即校时，之后每 5 秒校时；每连接至多一个探针，10 秒无有效回复即关闭并进入既有重连。后台恢复/online 立即刷新校时。按四时间戳扣除服务端处理耗时，估计 RTT 和 epoch 相对 `performance.now()` 的偏移；偏移与 RTT 使用 EWMA（0.2），展示时钟不倒退。每次收取权威消息固定单调接收锚点，组件重挂载不能重新授予时间。

展示的可提交时间为 `max(0, deadline - estimatedServerNow - safetyMargin)`。余量为 `ceil(max(50, latestRTT/2, smoothedRTT/2) + 2*jitter + offsetResidual)`，jitter 为 RTT 相邻差值绝对值的 EWMA，offsetResidual 补偿平滑偏移仍落后于当前样本的差值。第一次校时前显示“正在校准服务器时间”，限时行动暂不可提交；归零显示“时间不足，等待服务器确认”，只关闭本地入口，不生成 Auto Action、不改 canonical。不限时行动不受余量限制。RTT >= 300ms 提示提前操作。

所有 Action/Time Bank 在 Schema 后、房间访问检查前固定服务端 `receivedAt`；`D-1/D` 优先于同一截止的 Timer，`D+1` 拒绝。原 `actionId/expectedSequence` 幂等与 epoch 校验保持不变。重连只重发仍匹配 tournament/hand/actor/sequence 的未知原命令；过期命令不阻塞新机会，回执和权威状态任一先到均能回收 pending。

## 后果与边界

客户端与服务端必须同时升级/回滚，无数据库迁移。网络非对称和未来突发延迟无法由有限样本保证，余量是保守 UX 估计；任何逾期/状态变化仍以服务端事件与明确错误提示裁决。单客户端延迟、失联或动画不暂停整桌。诊断与回归见 02/04/05/06 权威规格；慢客户端背压与全面真实链路门禁由 TEX-61/TEX-62 负责。
