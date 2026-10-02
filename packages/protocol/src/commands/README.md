# Commands

客户端到服务端的 HTTP / WebSocket 命令 Schema。WS 命令统一使用 `requestId`；`SUBMIT_ACTION` 还使用 `actionId` 和十进制字符串 `expectedSequence`。`validateClientCommand` 对不支持的认证版本返回 `UNSUPPORTED_PROTOCOL_VERSION`，其余结构错误安全归类为 `INVALID_MESSAGE`。

TEX-60：TIME_SYNC 使用 requestId 与 clientSentAt（本地单调毫秒，可含小数）。仅用于已认证连接的时间采样，不进入 Action 幂等或牌局队列；服务端不信任客户端时间作裁决。
