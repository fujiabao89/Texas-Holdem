# Protocol source

协议 Schema 唯一入口。`index.ts` 只重导出 Schema、Schema 推导类型和无副作用的投影/校验函数；不得引入服务端运行时、数据库、WebSocket 或 UI 依赖。

子目录：`commands/`（入站请求）、`events/`（出站消息）、`errors/`（稳定错误）、`schemas/`（通用字段、视图与投影）。每个外部对象都使用 strict Schema，禁止默默剥离未知字段。
