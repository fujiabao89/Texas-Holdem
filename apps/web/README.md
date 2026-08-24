# Web application

玩家 Web 客户端（Next.js 16 + React 19 + Tailwind CSS 4）。采用单一 `src/app` 路由入口；页面组合功能模块，扑克规则以服务端投影和共享协议为准，客户端绝不裁决牌局。

TEX-23 已建立路由壳、类型安全 `zh-CN` 文案、Jotai 纯 UI 状态、HTTP/WS Transport 与 Snapshot/Event 消费边界。创建/加入/Lobby、牌桌下注、动画、音效、赛果和历史仍由 TEX-24+ 实现；当前路由壳不包含这些业务页面。

## 命令

```bash
pnpm --filter @texas-holdem/web dev        # 本地开发
pnpm --filter @texas-holdem/web build      # 生产构建
pnpm --filter @texas-holdem/web lint       # ESLint
pnpm --filter @texas-holdem/web typecheck  # tsc --noEmit
```

也可经根目录 `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` 由 Turbo 统一编排。

## 结构

- `src/app/` — App Router 路由壳与全局 Provider；没有 `pages` router。
- `src/protocol/` — 严格 Schema 边界的 HTTP/WS 客户端、当前 Tab Token 存储。
- `src/state/` — Server 投影镜像、重同步状态与纯 UI Jotai atoms。
- `src/messages/` — 唯一的 P0 中文用户文案与类型安全 key。

## 环境变量

见 [.env.example](./.env.example)。仅 `NEXT_PUBLIC_*` 前缀变量暴露到浏览器，只放非敏感公开配置；敏感值只由部署平台注入。HTTP API 和 WebSocket base URL 可以使用该公开配置；`playerToken` 绝不能写入 URL、环境变量或日志。
