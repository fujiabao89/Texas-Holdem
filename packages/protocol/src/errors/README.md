# Errors

稳定 ErrorCode、ErrorEnvelope 及安全错误构造器。`createProtocolError` 只生成固定消息，并按错误码白名单校验 `details`，避免 Token、堆栈、SQL、牌堆或私有牌进入 wire 错误。

TEX-54 新增 HTTP 错误 `TOURNAMENT_NOT_FOUND`、`TOURNAMENT_NOT_FINISHED` 与 `TOURNAMENT_RESULT_INCOMPLETE`；无额外 details 字段。HTTP 状态/可重试语义见 [02](../../../../docs/02-protocol-spec.md) 的 TEX-54 契约。
