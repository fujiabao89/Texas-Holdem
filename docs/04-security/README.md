# Security documents

TEX-61：普通牌局诊断仅使用 `game-diagnostics.ts` 的字段白名单，禁止 Token、昵称、Deck、牌面、完整事件/命令或 Error 对象。ID 只进入结构化日志，不进入指标标签。恢复快照仍经当前身份/epoch 和接收者投影生成；成员结束后丢弃该连接未发送的旧牌局帧。`/health` 只暴露经格式校验的版本与 SHA，不枚举环境变量。保留和权限要求见 [运行手册](../05-operations/realtime-diagnostics.md)。

PR 风险观察器的外发策略、作者/维护者授权、Secret 权限、敏感路径、状态与公共报告边界以 [AI PR Router 接入说明](../03-engineering/ai-pr-router-observer.md#3-secret-与模型外发授权) 为准（TEX-64）。这些设置只用于工程审查辅助，不改变游戏身份、私密投影或真钱范围。

依赖补丁维护与剩余项的本地核验见 [依赖补丁验收记录](../03-engineering/dependency-patch-validation.md)。审计必须使用支持审计端点的 registry；安装冷却期校验与冻结锁文件安装保持启用。是否完成告警处理，以修复合入默认分支后的 Dependabot 复查为准。

TEX-51 启动恢复只加载 ACTIVE 成员的 HMAC 摘要和受支持 key ID，不存储/重签原 token，不复活 LEFT 身份。Host/成员/参赛者不一致时隔离，诊断不打印快照、昵称或摘要。未关闭 Room 的密钥须保持可用；本次不引入轮换系统。详见 [ADR-0003](../adr/0003-tex-51-room-recovery-authority.md)。

身份、权限、作弊防范、随机性、审计与威胁模型。真钱能力在明确合规范围前不纳入实现。

Hand History 的凭证有效期与成员资格遵循 [协议规格](../02-protocol-spec.md) §4.2 / §5；历史记录保留期不延长授权，见 [数据模型](../03-data-model.md) §5.10。TEX-36 对两个读取端点执行数据库侧状态校验。

TEX-53 新增 D/SB/BB 属公开投影字段，授权玩家、Bot 与淘汰观战者一致；私有牌、Deck/Burn 与凭证仍受 [协议规格](../02-protocol-spec.md) §9.4 原有隔离约束。新增字段不扩大订阅资格。

TEX-54 公开赛果使用所属未关闭 Room 的 ACTIVE HUMAN 成员授权（允许同 Room 非参赛成员），仅 Bearer Header 携带 Token；无查询参数、无身份缓存。验证按持久化 `token_key_id` 从当前/保留密钥环取密钥，旧 key 必须保留到其所属 Room 关闭，未知 key 失败关闭。响应白名单、no-store、错误脱敏与保留期到期规则见 [02](../02-protocol-spec.md) / [03](../03-data-model.md) 的 TEX-54 小节。只保留现有聚合HTTP指标，不新增请求/响应/异常本体审计日志；代理必须剔除Authorization与查询字符串。
