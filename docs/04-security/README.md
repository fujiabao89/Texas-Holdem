# Security documents

身份、权限、作弊防范、随机性、审计与威胁模型。真钱能力在明确合规范围前不纳入实现。

Hand History 的凭证有效期与成员资格遵循 [协议规格](../02-protocol-spec.md) §4.2 / §5；历史记录保留期不延长授权，见 [数据模型](../03-data-model.md) §5.10。TEX-36 对两个读取端点执行数据库侧状态校验。

TEX-54 公开赛果使用所属未关闭 Room 的 ACTIVE HUMAN 成员授权（允许同 Room 非参赛成员），仅 Bearer Header 携带 Token；无查询参数、无身份缓存。响应白名单、no-store、错误脱敏与保留期到期规则见 [02](../02-protocol-spec.md) / [03](../03-data-model.md) 的 TEX-54 小节。只保留现有聚合HTTP指标，不新增请求/响应/异常本体审计日志；代理必须剔除Authorization与查询字符串。
