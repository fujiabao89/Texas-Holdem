# 最小依赖补丁升级验收记录

日期：2026-10-01（Asia/Shanghai）。实现基线：`455b5dbb`。本记录描述本地候选变更，不表示已经合并或部署。

关联任务：[TEX-63 最小依赖补丁升级与安装验证](https://linear.app/texas-holdem/issue/TEX-63)。分支：`chore/TEX-63-minimal-dependency-patches`；任务与 PR 标题统一为 `[TEX-63] 最小依赖补丁升级与安装验证`，遵循 [CONTRIBUTING.md](../../CONTRIBUTING.md)。本任务由用户直接委派 Codex 实施，已完成本地验证，等待 PR 的 CI、评审与合并决策。

## 范围

| 依赖 | 原锁定版本 | 候选版本 |
| --- | --- | --- |
| Next.js 及其对应 `@next/env` / SWC 平台包 | 16.3.3 | 16.3.6 |
| Fastify | 5.12.1 | 5.12.5 |
| fast-uri（两条依赖链） | 3.1.5 / 4.1.2 | 3.1.8 / 4.1.5 |
| ip-address | 10.5.0 | 10.7.1 |
| brace-expansion（两条依赖链） | 2.1.4 / 5.0.9 | 2.1.7 / 5.0.12 |

仅提高两个应用的必要直接依赖最低版本并更新对应锁文件节点。不引入新运行时依赖、数据库迁移、业务代码修改或常规大版本升级。React、Jotai、Drizzle 与测试工具的直接依赖版本保持基线值。

pnpm 常规更新会同时重新解析部分无关的间接依赖。本次保留与补丁无关的原锁定节点，只更换目标依赖及其 registry 校验和，再以冻结锁文件安装验证。所用校验和来自 npm 官方 registry；不降低 pnpm 的发布冷却期或完整性校验要求。

## 验证

审计使用 `pnpm audit --registry=https://registry.npmjs.org --json`；本机默认镜像没有所需审计端点，因此不能把镜像审计失败当作没有告警。候选锁文件的审计结果为 0 critical、0 high、1 moderate；与 GitHub 当前 25 个开放告警对应，候选覆盖其中 24 个，剩余项为下述旧 esbuild 链。

| 命令 / 检查 | 本地结果 |
| --- | --- |
| `pnpm install --force --frozen-lockfile --registry=https://registry.npmjs.org` | 通过；492 个锁定节点通过供应链策略校验，未放宽发布冷却期。随后常规冻结安装再次通过 |
| `pnpm lint` | 通过；既有 `gateway-protocol.test.ts:61` 未使用变量警告 1 个，0 错误 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；Next.js 16.3.6 生产构建，以及扑克引擎、协议包与服务端构建完成 |
| `pnpm test --maxWorkers=4` | 90 个测试文件通过、13 个文件跳过；930 项通过、101 项因无测试数据库跳过 |
| `pnpm exec tsx tests/simulator/run.ts --tier smoke --sha 455b5dbb` | 通过；200 场、33,260 手、67,786 动作；SHA 参数取实现基线以派生本地可复现 seed，不是未提交候选的发布 SHA |
| `TEX_E2E_PORT=3168 pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=2` | 219 项全部通过，耗时 4.3 分钟；独立端口，禁用重试 |
| Prettier、`git diff --check`、本记录与改动 README 的本地链接检查 | 通过 |

数据库集成测试未作为通过证据；本机无 `TEX_TEST_DATABASE_URL`，Docker 后台未运行。真实数据库 E2E 与性能 smoke 尚未运行，后续 PR 必须由配置真实 PostgreSQL 的 CI 验证。

权威测试入口与真实数据库要求仍以 [06 · 测试方案](../06-testing-strategy.md) 和 [质量基线](./monorepo-and-quality-baseline.md) 为准。

## 剩余项与交付边界

`drizzle-kit@0.31.10` 经 `@esbuild-kit/esm-loader@2.6.5` / `@esbuild-kit/core-utils@3.3.2` 引入 `esbuild@0.18.20`，上游范围固定为 `~0.18.20`。本次不强制把它跨到 0.25，也不移除数据库工具；需要单独评估工具链迁移及 schema 生成、加载回归。另有 Drizzle 自身使用的 esbuild 0.25.4，这不表示旧链已经移除。

本次改动与现有 Dependabot PR #64 / #65 的 Next.js、Fastify 升级范围重叠；候选交付后应协调这些 PR，避免重复升级。PR #62 的常规升级与 Jotai 主版本迁移不在本次范围。

GitHub 的告警基于默认分支，未合并的本地候选不会关闭告警；只有合入 `main` 并重新扫描后，才能确认平台上的剩余数量。正式部署另由用户决定。

## 文档同步检查

- 根 README、两个应用 README、工程索引与安全 README：同步依赖基线、记录入口和审计说明。
- 工程规格 01–06、测试目录 README、运维说明：已检查，无需更新；没有改变规则、协议、接口、数据模型、运行流程或既有测试入口。
- 任务卡 / 路线图：已在项目索引关联 TEX-63 与本记录；任务验收条件、分支和验证限制已同步至 Linear。产品范围与优先级未改变，路线图无需调整；候选等待 CI 和 PR 评审。
