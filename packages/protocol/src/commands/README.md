# Commands

客户端到服务端的 HTTP / WebSocket 命令 Schema。WS 命令统一使用 `requestId`；`SUBMIT_ACTION` 还使用 `actionId` 和十进制字符串 `expectedSequence`。`validateClientCommand` 对不支持的认证版本返回 `UNSUPPORTED_PROTOCOL_VERSION`，其余结构错误安全归类为 `INVALID_MESSAGE`。
