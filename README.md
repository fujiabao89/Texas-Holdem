# Texas Hold'em

极简、白色主体、响应式的 No-Limit Texas Hold'em Web 游戏。产品与规则以《德州扑克项目总规划》为权威；工程规格入口见 [docs/README.md](./docs/README.md)。

当前处于 P0 工程地基阶段（TEX-11）：已建立可安装、可 lint / typecheck / build / test 的 pnpm monorepo 骨架，尚未实现扑克规则、协议或业务逻辑。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/web` | Next.js 16 + React 19 + Tailwind CSS 4 玩家客户端 |
| `apps/game-server` | Node.js + Fastify + `@fastify/websocket` 实时游戏服务 |
| `packages/` | 跨应用共享包（`poker-engine`、`protocol` 等按后续任务落地） |
| `tests/` | 跨应用 e2e / 模拟 / 性能测试（TEX-12 起建设） |
| `docs/` | 工程规格与 P0 任务卡 |

## 快速开始

```bash
pnpm install      # 按 pnpm-lock.yaml 安装依赖（CI 使用 --frozen-lockfile）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm build        # 构建（Next 生产构建 + game-server 编译）
pnpm test         # 运行测试
```

环境变量样例见 `apps/web/.env.example` 与 `apps/game-server/.env.example`；敏感值只由部署平台注入，绝不提交。

## 约定

- 分支与 Linear 任务命名：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 多 Agent 协作契约：[AGENTS.md](./AGENTS.md)；角色入口：`CLAUDE.md` / `TRAE.md` / `CODEX.md`
- 许可证：[Apache-2.0](./LICENSE)；安全披露：[SECURITY.md](./SECURITY.md)
