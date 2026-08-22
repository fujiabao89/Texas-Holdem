# Web application

玩家 Web 客户端（Next.js 16 + React 19 + Tailwind CSS 4）。采用单一 `src/app` 路由入口；页面组合功能模块，扑克规则以服务端投影和共享协议为准，客户端绝不裁决牌局。

## 命令

```bash
pnpm --filter @texas-holdem/web dev        # 本地开发
pnpm --filter @texas-holdem/web build      # 生产构建
pnpm --filter @texas-holdem/web lint       # ESLint
pnpm --filter @texas-holdem/web typecheck  # tsc --noEmit
```

也可经根目录 `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` 由 Turbo 统一编排。

## 结构

- `src/app/` — App Router 路由入口（`layout.tsx`、`page.tsx`、`globals.css`）。
- `src/` 下其余功能目录（`features`、`components`、`stores` 等）将在后续任务落地。

## 环境变量

见 [.env.example](./.env.example)。仅 `NEXT_PUBLIC_*` 前缀变量暴露到浏览器，只放非敏感公开配置；敏感值只由部署平台注入。
