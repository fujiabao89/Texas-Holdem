# Deployment

环境部署编排、发布步骤和平台适配。

## Azure 最简部署教程（App Service + PostgreSQL）

本教程只提供操作步骤，不代部署。目标拓扑：

- `apps/game-server`：1 个 Azure App Service（Linux / Node 22）
- `apps/web`：1 个 Azure App Service（Linux / Node 22）
- 数据库：Azure Database for PostgreSQL Flexible Server

> 前提：仓库可本地执行 `pnpm install && pnpm build`，并已准备 Azure 订阅与 GitHub 仓库访问权限。

### 1. 创建基础资源

1. 创建同一区域的 Resource Group（例如 `rg-texas-holdem-prod`）。
2. 创建 Azure Database for PostgreSQL Flexible Server 与业务数据库。
3. 记录数据库连接串，后续写入 `DATABASE_URL`（仅平台注入，不入库）。

### 2. 部署后端（`apps/game-server`）

1. 创建 Linux App Service（Node 22）。
2. 在 Deployment Center 绑定仓库与目标分支（持续部署）。
3. 将构建/启动聚焦到后端包（monorepo 内仅构建与启动 `@texas-holdem/game-server`）。
4. 在 App Service 配置环境变量：
   - `PORT=3001`
   - `HOST=0.0.0.0`
   - `TOKEN_HMAC_SECRET=<至少32字符强随机密钥>`
   - `TOKEN_HMAC_KEY_ID=v1`
   - `DATABASE_URL=<Azure PostgreSQL 连接串>`
   - `DATABASE_SCHEMA=game`
   - `CORS_ALLOWED_ORIGINS=https://<前端域名>`
5. 在 App Service 配置中启用 WebSockets。

### 3. 执行数据库迁移

1. 在后端运行环境执行 `pnpm --filter @texas-holdem/game-server db:migrate`。
2. 确认 `game` schema 与迁移表均已创建后，再进行前端联调。

### 4. 部署前端（`apps/web`）

1. 创建第二个 Linux App Service（Node 22）。
2. 在 Deployment Center 绑定同一仓库/分支。
3. 配置前端环境变量：
   - `NEXT_PUBLIC_API_BASE_URL=https://<后端域名>`
   - `NEXT_PUBLIC_WS_URL=wss://<后端域名>/api/v1/ws`
4. 启动前端应用（`@texas-holdem/web`，对应 `next start`）。

### 5. 上线验收

- 可完成：创建房间 → 加入房间 → 开始对局 → 基础操作链路。
- WebSocket 连接稳定，断线可重连。
- 后端 CORS 仅允许前端域名。
- 日志无 token、密钥、数据库凭据泄露。
- 健康检查端点可访问（`/health`）。

### 6. 生产加固建议

- 绑定自定义域名与 HTTPS 证书。
- 使用 Key Vault 托管密钥，再注入 App Service。
- 配置 Application Insights 与告警。
- 收紧数据库网络（VNet / Private Endpoint）。
- 按 `dev/staging/prod` 做前后端独立环境配置。
