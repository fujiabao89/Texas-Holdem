# TEX-48 验收记录

日期：2026-10-24。任务：[TEX-48](https://linear.app/texas-holdem/issue/TEX-48)。分支：`feat/TEX-48-reopen-lobby-and-invite-lifecycle`。用户已将本任务实现委派 Codex。

## 交付范围

- 共享协议新增严格 REOPEN_LOBBY HTTP operation，沿用 expectedRoomRevision、Bearer、Idempotency-Key 与权威 RoomSnapshot。
- FINISHED 停留展示结果，房主显式重新开放；恢复原邀请码、配置、成员与合法座位，真人 Ready=false/PokerStatus=ACTIVE。START 只接受 LOBBY，校验在线、入座、准备、人数和无活跃比赛；旧终局信号不能覆盖大厅或新赛。
- IN_GAME/FINISHED 暂停邀请码 Join，公开 Snapshot 只在 LOBBY 含邀请码；Token 重连独立鉴权。CLOSED 在轻量墓碑驻留期返回 INVITE_EXPIRED，回收后 INVALID_INVITE_CODE，均不能加入原 Room。
- Room 管理 LOBBY/FINISHED 的 60 秒 Host Grace：代次/截止点/当前身份在队列复核，持久化后广播；重连取消，无在线后继者则等待首位真人连接，主动离开立即转移。关闭与恢复撤销/卸载清理 Timer。
- 新 Tournament 使用新 ID、场号、参赛身份行和配置初始筹码；旧结果和 Hand History 保留原授权。Bot 默认 Ready 的既有 P1 语义保留，不新增 Bot 入口。
- 前端仅同步共享测试夹具；不改页面、按钮、文案或 Transport。两个既有浏览器第二场用例先断言旧入口 ROOM_LOCKED，再用真实 HTTP 重开和现有 Lobby UI 重新准备，保留新旧赛隔离验证。

## 验证证据

| 命令 | 结果 | 覆盖 |
| --- | --- | --- |
| `pnpm exec vitest run --project unit --project ws` | 100 文件、1039 项通过 | 协议严格性、HTTP 幂等/拒绝/回滚、加入与开始竞态、Host Grace、重连/私有投影、现有生命周期 soak 与前端夹具兼容 |
| `TEX_TEST_DATABASE_URL=<隔离本地库> pnpm exec vitest run --project integration apps/game-server/tests/integration/terminal-history.test.ts apps/game-server/tests/integration/hand-commit-bundle.test.ts` | 2 文件、22 项通过 | 真实生产 Executor→Bundle→PostgreSQL→历史 HTTP；重开 LOBBY、新场号/初始筹码/空排名与旧历史授权；延迟终局不覆写 LOBBY/新赛、事务/锁/幂等回归 |
| `pnpm typecheck` | 通过 | 全工作区和根测试 TypeScript 检查 |
| `pnpm --filter @texas-holdem/game-server build` | 通过 | 服务端产物编译；共享包构建由 typecheck 依赖完成 |
| `pnpm lint` | 通过（0 errors） | 存量 gateway-protocol.test.ts 的未使用变量 warning 保留，不做任务外清理 |
| Chromium 真实链路：`multiplayer-journey.spec.ts --grep 双人完整`、`result-recovery.spec.ts --grep 多轮共存`（各 workers=1，无重试） | 两次各 1 项通过 | 实际浏览器→HTTP/WS→生产 game-server→隔离 PostgreSQL；旧入口拒绝、显式重开/准备/第二场、旧赛果刷新隔离 |
| `pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers 2 tests/e2e/betting tests/e2e/reconnect tests/e2e/animation-audio tests/e2e/seats tests/e2e/table-layout` | 215 项通过（4.2 分钟，无重试） | 全部受影响模拟快照夹具的下注、重连、动效、座位和响应式牌桌回归 |
| `git diff --check` | 通过 | 补丁空白检查 |

PostgreSQL 使用本任务本地 `.cache` 中的独立临时实例（loopback），每组测试再创建独立 schema 并清理；未连接生产数据库、未变更项目依赖或提交数据库产物。驱动输出既有 query 排队弃用提示；没有测试失败。

新增/更新定向资产：`src/rooms/lobby-lifecycle.test.ts`、`tests/ws/lobby-lifecycle.test.ts`、`src/persistence/room-recovery.test.ts`、既有 Room/Protocol 测试与 bounded lifecycle soak、两份真实 PostgreSQL 集成用例。

## 文档同步检查

已更新总规划、02/03/04/05/06 权威规格、ADR-0007、项目/工程/ADR/总索引、相关 Room/HTTP/Persistence/Protocol/Test README、前端测试夹具 README、安全与恢复说明。

数据库 Schema/迁移、环境变量、部署拓扑、监控指标及纯扑克引擎规格：**已检查，无需更新**。本任务复用原状态枚举、Room/成员/Tournament 表与现有配置，不引入字段、配置、指标或扑克规则变更。

## 边界与交接

- TEX-49 必须接入重新开放筹备大厅的新按钮和导航，原结果页“再来一局”的直接 START 当前会收到 ROOM_LOCKED；测试中的 HTTP 桥接不代表该产品入口已经实现。
- 未提交终局后立即进程崩溃，若持久 LOBBY 与旧 IN_GAME 记录矛盾，仍按 ADR-0003 保守隔离；不能从浏览器赛果伪造持久根。无本次新增数据迁移。
- 浏览器全矩阵与生产发布由相应任务/CI 验证，不以本地单元/WS 结果替代。
- 不合并或部署；PR 最终批准与发布由用户决定。未主动调用 DeepSeek Harness 或 Greptile 审查。
