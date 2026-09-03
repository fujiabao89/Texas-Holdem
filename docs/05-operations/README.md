# Operations documents

部署、发布、回滚、事故响应和运行维护说明。

## TEX-36 协议升级

wire v3 的客户端与 game-server 必须同时发布或同时回滚；旧主版本按 `UNSUPPORTED_PROTOCOL_VERSION` 拒绝。HTTP 路径仍是 `/api/v1`，不需要数据库迁移，既有 Engine 历史事件在读取时使用新投影。决策见 [ADR-0002](../adr/0002-tex-36-championless-history.md)。
