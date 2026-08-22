# Monorepo 与质量基线

> 状态：已实现（TEX-11）
> 权威技术选型：根目录《德州扑克项目总规划》§6

本文件说明单仓库的工程结构、质量命令与工具链。它不复制扑克规则、协议或数据模型——这些始终以 `docs/01` 至 `docs/06` 与《德州扑克项目总规划》为权威来源。

## 单仓库结构

- **包管理**：pnpm workspace（`pnpm-workspace.yaml` 声明 `apps/*`、`packages/*`）。
- **任务编排**：Turborepo（`turbo.json`）；根 `package.json` 的质量脚本是稳定入口。
- **`apps/web`**：Next.js 16 + React 19 + TypeScript + Tailwind CSS 4。
- **`apps/game-server`**：Node.js + Fastify + `@fastify/websocket`。

`packages/` 下当前没有已创建的包；`poker-engine`、`protocol` 等为规划占位，将在后续任务落地（见 [packages/README.md](../../packages/README.md)）。

## 质量命令

| 命令 | 作用 |
| --- | --- |
| `pnpm lint` | 经 Turbo 对各包运行 ESLint（flat config：typescript-eslint + react-hooks） |
| `pnpm typecheck` | 经 Turbo 对各包运行 `tsc --noEmit` |
| `pnpm build` | 经 Turbo 构建：`apps/web` 为 `next build`，`apps/game-server` 为 `tsc` 产出 `dist/` |
| `pnpm test` | 经 Turbo 运行各包测试（当前为 `apps/game-server` 的 vitest 冒烟测试） |

安装与锁定：首次 `pnpm install` 生成 `pnpm-lock.yaml`；之后使用 `pnpm install --frozen-lockfile` 保证可复现。CI（`.github/workflows/ci.yml` 的 `quality` 任务）在干净环境执行 `pnpm install --frozen-lockfile` 后，依次运行 `lint`、`typecheck`、`build`、`test`。

## 共享配置

- `tsconfig.base.json`：共享 TypeScript 严格选项，各包通过 `extends` 引用。
- `eslint.config.mjs`：根 ESLint flat config，覆盖所有包，未逐包复制。
- `.prettierrc.json` / `.prettierignore`：格式化，经 `pnpm format` / `pnpm format:check` 调用。

## 环境变量与密钥

- 样例：`apps/web/.env.example`、`apps/game-server/.env.example`（均不含密钥）。
- 敏感值（数据库凭据、令牌密钥等）只由部署平台注入，绝不提交。
- 前端仅 `NEXT_PUBLIC_*` 前缀变量暴露到浏览器，只放非敏感公开配置。
- `.gitignore` 忽略 `.env`、`.env.*`（保留 `!.env.example`）。

## 依赖边界（预留，不在 TEX-11 实现）

- 扑克规则只属于 `packages/poker-engine`，不得依赖网络、数据库、UI 或框架。
- 通信 Schema 与推导类型只属于 `packages/protocol`，客户端和服务端不维护平行 DTO。
- `apps/game-server` 保持权威状态并校验所有客户端输入；`apps/web` 只展示投影并提交命令，绝不裁决牌局。

详见《德州扑克项目总规划》§6，以及 `docs/01-engine-spec.md`、`docs/02-protocol-spec.md` 等权威规格。
