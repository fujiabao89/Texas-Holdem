# Texas Hold'em

极简、白色主体、响应式的 No-Limit Texas Hold'em Web 游戏。产品与规则以《德州扑克项目总规划》为权威；工程规格入口见 [docs/README.md](./docs/README.md)。

当前处于 P0 的稳定性、复玩体验与发布验收阶段。扑克规则引擎、服务端权威运行时、持久化、实时重连、Web 大厅与牌桌等基础能力已经落地；当前 `origin/main` 基线为 `ebdbce16`。River & Raise 首页及牌桌视觉任务 TEX-44/TEX-45 尚在评审中，不应视为已合并或已发布。接下来优先闭合服务重启恢复、终局对象清理、盲注位置投影、可恢复赛果、“再来一局”以及真实移动设备验收，详见 [项目现状与后续改进路线图](./docs/00-project/current-status-and-follow-up-roadmap.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/web` | Next.js 16 + React 19 + Tailwind CSS 4 玩家客户端 |
| `apps/game-server` | Node.js + Fastify + `@fastify/websocket` 实时游戏服务 |
| `packages/` | 跨应用共享包，包括纯规则 `poker-engine` 与通信契约 `protocol` |
| `tests/` | 跨应用测试：分层入口、可复用测试工具、E2E、Simulator（见 [tests/README.md](./tests/README.md)） |
| `docs/` | 工程规格与 P0 任务卡 |

## 快速开始

```bash
pnpm install      # 按 pnpm-lock.yaml 安装依赖（CI 使用 --frozen-lockfile）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm build        # 构建（Next 生产构建 + game-server 编译）
pnpm test         # 全部 Vitest 层（unit + rules + integration + ws）
pnpm test:unit | test:rules | test:integration | test:ws   # 分层独立调用
pnpm test:e2e     # Playwright E2E（自动启动 web dev server）
pnpm test:sim -- --seed 20260821   # Headless Simulator（单 seed 批次；--tier smoke|nightly|rc 见 tests/simulator/README.md）
```

环境变量样例见 `apps/web/.env.example` 与 `apps/game-server/.env.example`；敏感值只由部署平台注入，绝不提交。

## 约定

- 分支与 Linear 任务命名：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 多 Agent 协作契约：[AGENTS.md](./AGENTS.md)；角色入口：`CLAUDE.md` / `TRAE.md` / `CODEX.md`
- 许可证：[Apache-2.0](./LICENSE)；安全披露：[SECURITY.md](./SECURITY.md)
