# TEX-60 校时与弱网操作运行说明

客户端与 game-server 必须一起发布/回滚 wire v6；v5 客户端得到 UNSUPPORTED_PROTOCOL_VERSION 并刷新。HTTP 仍为 /api/v1；无数据库迁移、秘密配置或新增持久化。时间同步契约与估算法以 [02 §8.5](../02-protocol-spec.md)、[05 §11.1](../05-frontend-spec.md) 为准，决策见 [ADR-0006](../adr/0006-tex-60-network-fair-action-clock.md)。

原生 WS 15/45 秒心跳保持。应用层每连接一条探针、5 秒采样、10 秒无有效回复重连；代理须允许 TIME_SYNC 与 TIME_SYNC_RESULT。正常探针直接经网关返回，不排入比赛队列，不修改任何玩家 deadline，不暂停整桌。

“正在校准服务器时间”持续存在时排查版本、认证、代理与双向 WS 连通性；“网络延迟较高”提示 RTT >= 300ms，建议提前操作；“时间不足”指网络安全余量耗尽，不能据此判断服务器已经弃牌。“操作到达服务器时已超时”会要求权威 Snapshot，操作结果仍看 Event/Snapshot。即使浏览器恢复/重连也不会重新授予完整行动时间。

同一机会保留曾经需要的较大余量，避免抖动恢复使倒计时回跳；真正 Time Bank 延长或新机会可以使用最新余量。未知操作只按原始 requestId/actionId/payload 在原机会仍有效时重发，旧命令不能作用于新手或新比赛。

诊断沿用脱敏 WS 消息计数、重连与 Action Rejection 指标；TIME_SYNC_RESULT 计入消息写出。不记录 Token、底牌或原始 probe payload，不新增玩家 ID 高基数标签。服务端与客户端单调时钟是实现前提；启动前保持主机系统时间正常，运行中墙钟调整不参与裁决。

有限样本无法保证未来突发延迟或任意非对称链路安全；安全余量只改善 UX，逾期仍服务端拒绝。Release 可在隔离环境注入 RTT/抖动并检查校时、Time Bank、D 边界、重连剩余时间。回归命令与本地结果见 [验收记录](../03-engineering/TEX-60-acceptance.md)；慢客户端背压与真实链路完整门禁分别属 TEX-61/TEX-62。

PR #69 R1：普通下注提示时间不足时，若 Time Bank 有余额且估计服务器 deadline 尚未到达，延时入口仍可用。达到估计 deadline 才关闭延时；申请的实际到达时间和结果仍以服务端为准，不保证网络余量内的申请一定成功。
