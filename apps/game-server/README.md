# Game server

游戏服务运行时（Node.js + Fastify + `@fastify/websocket`）：鉴权、房间调度、连接管理、持久化编排和对纯扑克引擎的调用。服务端是权威状态源，客户端只提交命令。

## 命令

```bash
pnpm --filter @texas-holdem/game-server dev        # tsx watch 开发
pnpm --filter @texas-holdem/game-server build      # tsc 编译到 dist/
pnpm --filter @texas-holdem/game-server start      # node dist/main.js
pnpm --filter @texas-holdem/game-server typecheck  # tsc --noEmit
pnpm --filter @texas-holdem/game-server db:generate  # 从 Drizzle schema 生成迁移（见 src/infrastructure/persistence/migrations/README.md 审查清单）
pnpm --filter @texas-holdem/game-server db:migrate   # 对 DATABASE_SCHEMA 执行版本化迁移
```

也可经根目录 `pnpm dev` / `pnpm build` / `pnpm typecheck` 由 Turbo 统一编排。测试由根目录分层入口统一调用（TEX-12）：`pnpm test:unit`（含 `src/app.test.ts`）、`pnpm test:integration`、`pnpm test:ws`，见 [tests/README.md](../../tests/README.md) 与本包 [tests/](./tests/README.md)。

## HTTP 端点（TEX-19）

低频 Room/Lobby HTTP 生命周期。wire 契约权威在 [docs/02-protocol-spec.md](../../docs/02-protocol-spec.md) §4/§8；本服务只使用 `packages/protocol` 导出的请求/响应/Error Schema，成功一律 `{ data }`、失败一律 `ErrorEnvelope`。

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/v1/rooms` | 创建房间并加入创建者（创建者即 Host） |
| `POST /api/v1/rooms/join` | 以邀请码加入（邀请码只定位 Room，非身份凭证） |
| `PATCH /api/v1/rooms/{roomId}` | 低频 Lobby 设置：`UPDATE_CONFIG` / `KICK_PLAYER`（仅 Host、仅 LOBBY）、`CHANGE_SEAT`（仅移动当前身份） |
| `POST /api/v1/rooms/{roomId}/tournaments` | 开局（仅 Host；LOBBY + 2–10 真人全部入座 + 全部 Ready + revision 精确匹配） |
| `POST /api/v1/rooms/{roomId}/leave` | 主动离开（Host 离开立即转移 Host） |

- 受保护接口使用 `Authorization: Bearer <playerToken>`；服务端由 token HMAC 摘要反查 `playerId`，不信任请求携带的身份。`playerToken` 至少 256-bit 熵，仅在创建/加入响应返回；持久化只存摘要。
- 所有状态变更 `POST/PATCH` 强制 `Idempotency-Key`（UUID v4）；作用域 = 身份/源 IP + endpoint + key。同 Payload 重试返回原结果，同 Key 不同 Payload 返回 `IDEMPOTENCY_KEY_REUSE`。
- 限流：`@fastify/rate-limit` 全局 per-IP（受保护变更 60/min，CodeQL 识别为路由级限流）；自定义 TokenBucket 保留规格额度（创建 5/min 且 30/hour、Join 20/min、按 inviteCode 10/min）；429 保持 ErrorEnvelope。HTTP Body 上限 64KiB；CORS 使用显式 Allowlist（见 `.env.example`）。
- `SET_READY` 属 WebSocket 命令（TEX-21）；本任务在 Room 串行执行器层实现 Ready 语义并提供可注入入口，HTTP 不暴露。

## 结构

- `src/app.ts` — `buildApp()` 构建 Fastify 实例：`/health`、显式 CORS Allowlist、64KiB body 上限、注册 Room HTTP 路由。
- `src/main.ts` — 进程启动入口：解析配置、创建数据库与仓储、装配 RoomManager、监听 `PORT` / `HOST`。
- `src/config.ts` — 运行时配置解析（`TOKEN_HMAC_SECRET` / `CORS_ALLOWED_ORIGINS` 等，启动校验）。
- `src/http/` — HTTP 入口与安全中间件（routes/rooms.ts、auth/idempotency/rate-limit、错误→ErrorEnvelope 映射），见 [src/http/README.md](./src/http/README.md)。
- `src/rooms/` — Room/Lobby 权威状态机、串行执行器、集合管理、凭证生成与 TournamentStarter port，见 [src/rooms/README.md](./src/rooms/README.md)。
- `src/infrastructure/persistence/` — Supabase PostgreSQL 持久化（Drizzle ORM + `pg`；Schema/迁移/连接/仓储，TEX-18），见 [src/infrastructure/persistence/README.md](./src/infrastructure/persistence/README.md)。
- `src/app.test.ts` — vitest 冒烟测试（unit 层，经根 `pnpm test:unit` 收集）。
- `tests/` — unit / integration / ws 分层测试与 fixtures，见 [tests/README.md](./tests/README.md)。

## 环境变量

见 [.env.example](./.env.example)。非敏感运行配置（`PORT`、`HOST`）可本地覆盖；敏感值（数据库凭据、令牌密钥等）只由部署平台注入。

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | 否 | HTTP 监听（默认 3001 / 0.0.0.0） |
| `TOKEN_HMAC_SECRET` | 是 | playerToken 摘要 HMAC 密钥（≥32 字符）；只存服务端环境注入 |
| `TOKEN_HMAC_KEY_ID` | 否 | 密钥版本标识（默认 `v1`） |
| `CORS_ALLOWED_ORIGINS` | 否 | 显式 CORS Allowlist（逗号分隔，不使用通配来源） |
| `DATABASE_URL` | 迁移/持久化时 | PostgreSQL 连接串（含 Supabase）；只进部署平台注入 |
| `DATABASE_SCHEMA` | 否 | 持久化目标 schema（默认 `game` 私有 schema，不暴露给 PostgREST/GraphQL） |
| `DATABASE_POOL_MAX` / `DATABASE_POOL_IDLE_TIMEOUT_MS` / `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 否 | 连接池参数覆盖 |
| `TEX_TEST_DATABASE_URL` | 集成测试 | 测试库连接串；缺省时数据库集成测试受控跳过（TEX-12 约定） |
