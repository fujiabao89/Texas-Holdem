# Deployment（TEX-40 发布运行手册）

Game Server 最小运行 artifact 的构建、校验、隔离 smoke、受控迁移与回滚编排。本目录是**可执行、可审计**的发布运行手册；运维/事故说明见 [docs/05-operations/README.md](../../docs/05-operations/README.md)。

## 范围与责任边界

| 目录/文件 | 职责 |
| --- | --- |
| `scripts/build-artifact.mjs` | 干净 checkout 内构建最小运行 artifact（含 manifest/校验） |
| `scripts/verify-artifact.mjs` | 解压/激活前校验 tarball SHA、内容摘要与关键文件 |
| `scripts/artifact-smoke.mjs` | 隔离 PostgreSQL 上的 artifact 级 HTTP/WS smoke |
| `scripts/release.mjs` | 受控发布/回滚最小编排（status/deploy/rollback，默认 dry-run） |
| `scripts/lib/artifact-lib.mjs` | 共享纯函数（摘要/校验/审计脱敏/进程封装） |
| `tests/*.test.mjs` | 编排纯函数单元测试（`pnpm test:release`） |
| `.github/workflows/release-artifact.yml` | 固定 SHA 的 artifact 构建 + 隔离 smoke CI |

**不属于本任务**（不越界）：Nginx/反代安全与 `HOST` 单实例基线（TEX-41）；数据库锁/schema/恢复演练（TEX-42）；预发布演练、外部观测、回滚演练（TEX-43）；拓扑与外部决策（TEX-39）。本目录只提供上述任务可调用的最小发布原语与占位。

## 1. Artifact

### 1.1 构建（可重复入口）

```bash
pnpm install --frozen-lockfile          # 干净 checkout 后
node infra/deployment/scripts/build-artifact.mjs --out-dir <out> [--no-archive]
```

同一 checkout 依次：按依赖顺序 `tsc` 构建 `poker-engine` → `protocol` → `game-server`；`pnpm deploy --legacy --prod` 生成自包含 `node_modules`（无 devDeps/store）；以刚构建的 `dist` 覆盖并把版本化迁移 `*.sql` + `meta/_journal.json` 补入 dist 迁移路径（migrator 以 `__dirname` 读取）；补全 workspace 传递依赖（`protocol → zod`）为真实副本；写入 runtime `package.json`；做模块解析自检与“生产启动命令在缺 `DATABASE_URL` 时按预期失败”探针。

**干净工作树强制**：build-artifact 在构建前拒绝任何 tracked/untracked 工作树改动（错误信息要求从干净 checkout 构建），并支持 `--expect-git-sha <40hex>` 断言实际 HEAD 与预期不可变提交一致——防止未提交代码被标记为 HEAD artifact。

**产物组成**：`dist/`（编译产物 + 迁移 SQL/journal）、自包含生产 `node_modules/`（含两 workspace 包编译产物）、`package.json`。不含 monorepo 源码、pnpm store、开发依赖、Web/Next.js 产物、任何 Secret。

**输出**（`--out-dir`）：`game-server-<sha>.tar.gz`、`.tar.gz.sha256`、`.manifest.json`。

### 1.2 manifest（machine-readable）

至少含：`gitSha`、`buildTimeUtc`、`nodeVersion`、`pnpmVersion`、`lockfileSha256`、`tarballSha256`、`rootDigestSha256`（整树确定性摘要，含 node_modules）、关键文件 `checksums`、`commands.start`/`commands.migrate`。manifest 明确不含任何 Secret。

### 1.3 校验（失败即中止，不得继续部署）

```bash
node infra/deployment/scripts/verify-artifact.mjs \
  --archive <tar.gz> --manifest <manifest.json> --unpack-to <dir>   # tarball sha + 解压后摘要/关键文件
node infra/deployment/scripts/verify-artifact.mjs --dir <unpacked> --manifest <manifest.json>
```

**平台说明**：authoritative（Linux 相对符号链接、tar 往返移植）在 CI `release-artifact.yml` 校验；Windows 本地 node_modules 符号链接为绝对路径，tar 往返不用于解包校验——本地以 `--dir` 对构建产物目录做摘要校验 + tarball sha 校验（二者已验证），解包移植验证在 CI 完成。

## 2. 隔离 Artifact Smoke

要求一个**独占/可丢弃** PostgreSQL（会 DROP 目标 schema 与共享 `drizzle` journal，保证可重复）。CI 用独立 `postgres:16-alpine` service；本地可用一次性 docker 实例。

```bash
node infra/deployment/scripts/artifact-smoke.mjs \
  --runtime-dir <解包/构建的 artifact 目录> --database-url <独占库 pg url>
```

步骤：由 artifact 自身 migrator 在随机隔离 schema 执行版本化迁移 → `node dist/main.js`（`NODE_ENV=production`）启动 → 轮询 `HTTP /health = {status:"ok"}` → 真实 WS Upgrade `/api/v1/ws`：非法帧应答 `ERROR/INVALID_MESSAGE`、未认证 5s 服务端关闭码 `4003 (AUTH_FAILED)` → 清理进程/schema/journal。等待可观察就绪，不用任意 sleep、不只验证端口。

## 3. 受控迁移

- 只使用现有版本化迁移链与生产 migrator（`dist/infrastructure/persistence/migrations/migrate.js`）；**任何共享环境禁止 `drizzle-kit push`**（权威：`apps/game-server/src/infrastructure/persistence/migrations/README.md`、`docs/03-data-model.md`）。
- 迁移从**同一 SHA 的 artifact** 执行，不从目标机 checkout 源码执行。
- 部署顺序固定：完整性校验 → 发布锁 → 解包/校验 → 停旧（可配置/人工）→ 迁移 → 启动候选 → health → 激活/保留旧版。
- **不伪造“数据库自动回滚”**：已成功执行的不可逆/破坏性 schema 变更不能靠盲目 down migration 回滚；此情形只能回滚到兼容应用 artifact，或走 TEX-42 的经审查前向修复/恢复流程。跨部署 DB 锁、schema 语义、恢复策略明确交接 TEX-42。

## 4. 版本保留、部署与回滚（release.mjs）

按 SHA 不可变布局：`<RELEASE_ROOT>/releases/<sha>/`（不可变）+ **`<RELEASE_ROOT>/current` 运行目标**（指向当前运行版本目录的原子可切换链接）+ `state.json`（`current`/`previous`，仅作为审计视图，health 通过后才写入）+ `audit/release.jsonl` + `lock/`。至少保留上一份已验证 artifact。

**运行目标与 systemd 集成契约（供 TEX-41）**：服务启动前 release.mjs 先把 `current` 原子切换到候选 `releases/<sha>`，使服务必然从候选 artifact 启动；health 失败自动把 `current` 回切旧运行目标并尝试拉起旧版。**systemd 单元本身不被本编排修改**——TEX-41 落地时必须让 `ExecStart` 解析 `<RELEASE_ROOT>/current`（例如 `ExecStart=/usr/bin/node /srv/texas-holdem/current/dist/main.js`，配 `EnvironmentFile`），并以 start/stop/restart/status 固定动词接入 `SERVICE_CONTROL`。未满足该集成契约前，`SERVICE_CONTROL=systemctl/docker` 的自动启动/回切不可用。

```bash
export RELEASE_ROOT=/srv/texas-holdem/releases   # 版本根
export ARTIFACT_TARBALL=game-server-<sha>.tar.gz
export ARTIFACT_MANIFEST=game-server-<sha>.manifest.json
# 服务控制（TEX-41/用户决策项，真实主机必填其一；缺省 none 仅允许首装）
export SERVICE_CONTROL=systemctl; export SERVICE_NAME=texas-holdem-game-server
# 可选注入给应用的环境文件（可含 Secret，不写日志/审计）
export APP_ENV_FILE=/etc/texas-holdem/app.env
node infra/deployment/scripts/release.mjs status            # 只读
node infra/deployment/scripts/release.mjs deploy            # dry-run 打印计划
node infra/deployment/scripts/release.mjs deploy --apply    # 执行
node infra/deployment/scripts/release.mjs rollback --apply  # 回滚 state.previous
node infra/deployment/scripts/release.mjs rollback --to <sha> --apply   # 显式回滚目标
node infra/deployment/scripts/release.mjs deploy --apply --health-timeout-ms 90000  # 覆盖 health 轮询超时
```

语义与护栏：

- **默认安全失败**：无 `--apply` 一律 dry-run；所有路径/标识符校验；禁止 `eval` 与 shell 拼接外部数据；服务控制只允许固定动词。
- **migration/start/health 任一失败不激活**新版本；保留旧版本及可审计日志。
- **回滚前置**：验目标 release 完整性与 manifest；校验目标迁移 journal 是当前 journal 的**前缀**（schema 兼容，只切二进制、不做 down migration）；再停旧/启目标/health/对调 state。前缀不兼容则拒绝并提示 TEX-42 前向修复。
- **审计**：deploy/migrate/start/activate/rollback/status 每次追加不含 Secret 的记录（`at/action/phase/sha/result/operator/runId`），经 `sanitizeForAudit` 脱敏。Release 证据保留 180 天（对齐 `docs/06-testing-strategy.md` §10.2/§12.4）。

> **真实 systemd 服务名、服务器地址、域名、数据库凭据、发布介质、告警通道一律不得臆造**——以显式参数/占位提供，属 TEX-39/用户决策项（云厂商、区域、域名、备案、套餐、备份、预算、TLS），见 `docs/05-operations/README.md` 决策清单。

## 5. Secret 与证据红线

- artifact/manifest/审计/日志/测试输出不写 Secret；敏感运行值只经环境/`APP_ENV_FILE` 注入并透传子进程。
- 任何含 Token、完整 Deck、未公开底牌或 AI 隐藏 Reasoning 的数据禁止进入日志/审计/指标（权威：`docs/06-testing-strategy.md` §10.2、`docs/04-game-server-architecture.md`）。

## 权威文档链接

不复制第二套事实：迁移/协议/数据模型见 `docs/01-engine-spec.md`~`docs/06-testing-strategy.md`、`apps/game-server/src/infrastructure/persistence/migrations/README.md`、`docs/03-data-model.md`、`docs/04-game-server-architecture.md`；指标红线见 `infra/monitoring/README.md`。
