# Errors

稳定 ErrorCode、ErrorEnvelope 及安全错误构造器。`createProtocolError` 只生成固定消息，并按错误码白名单校验 `details`，避免 Token、堆栈、SQL、牌堆或私有牌进入 wire 错误。
