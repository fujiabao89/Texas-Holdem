# Game server

游戏服务运行时（Node.js + Fastify + `@fastify/websocket`）：鉴权、房间调度、连接管理、持久化编排和对纯扑克引擎的调用。服务端是权威状态源，客户端只提交命令。

## 命令

```bash
pnpm --filter @texas-holdem/game-server dev        # tsx watch 开发
pnpm --filter @texas-holdem/game-server build      # tsc 编译到 dist/
pnpm --filter @texas-holdem/game-server start      # node dist/main.js
pnpm --filter @texas-holdem/game-server test       # vitest
pnpm --filter @texas-holdem/game-server typecheck  # tsc --noEmit
```

也可经根目录 `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` 由 Turbo 统一编排。

## 结构

- `src/app.ts` — `buildApp()` 构建 Fastify 实例（当前仅 `/health`，便于测试注入与后续注册路由/WebSocket）。
- `src/main.ts` — 进程启动入口，监听 `PORT` / `HOST`（对齐 [docs/04-game-server-architecture.md](../../docs/04-game-server-architecture.md) §4.1 的 `main.ts` 命名）。
- `src/app.test.ts` — vitest 冒烟测试。

## 环境变量

见 [.env.example](./.env.example)。非敏感运行配置（`PORT`、`HOST`）可本地覆盖；敏感值（数据库凭据、令牌密钥等）只由部署平台注入。
