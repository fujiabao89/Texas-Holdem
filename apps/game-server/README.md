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

## 结构

- `src/app.ts` — `buildApp()` 构建 Fastify 实例（当前仅 `/health`，便于测试注入与后续注册路由/WebSocket）。
- `src/main.ts` — 进程启动入口，监听 `PORT` / `HOST`（对齐 [docs/04-game-server-architecture.md](../../docs/04-game-server-architecture.md) §4.1 的 `main.ts` 命名）。
- `src/app.test.ts` — vitest 冒烟测试（unit 层，经根 `pnpm test:unit` 收集）。
- `src/infrastructure/persistence/` — Supabase PostgreSQL 持久化（Drizzle ORM + `pg`；Schema/迁移/连接/仓储，TEX-18），见 [src/infrastructure/persistence/README.md](./src/infrastructure/persistence/README.md)。
- `tests/` — unit / integration / ws 分层测试与 fixtures，见 [tests/README.md](./tests/README.md)。

## 环境变量

见 [.env.example](./.env.example)。非敏感运行配置（`PORT`、`HOST`）可本地覆盖；敏感值（数据库凭据、令牌密钥等）只由部署平台注入。

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | 否 | HTTP 监听（默认 3001 / 0.0.0.0） |
| `DATABASE_URL` | 迁移/持久化时 | PostgreSQL 连接串（含 Supabase）；只进部署平台注入 |
| `DATABASE_SCHEMA` | 否 | 持久化目标 schema（默认 `game` 私有 schema，不暴露给 PostgREST/GraphQL） |
| `DATABASE_POOL_MAX` / `DATABASE_POOL_IDLE_TIMEOUT_MS` / `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 否 | 连接池参数覆盖 |
| `TEX_TEST_DATABASE_URL` | 集成测试 | 测试库连接串；缺省时数据库集成测试受控跳过（TEX-12 约定） |
