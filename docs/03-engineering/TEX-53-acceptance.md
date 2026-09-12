# TEX-53 权威庄位与盲注座位验收

- 日期：2026-09-12
- 分支：`feat/TEX-53-authoritative-blind-seats`
- 决定：[ADR-0003](../adr/0003-tex-53-authoritative-blind-seats.md)
- 权威字段与兼容规则：[02 §4.1 / §9.2](../02-protocol-spec.md)

## 交付

共享严格 Schema 的 PlayerView、BotView、GameSnapshot 与投影源增加公开 `smallBlindSeat/bigBlindSeat`，patch 支持可选字段与 null 清空。game-server 从当前 hand 读取 D/SB/BB，手末保留当前手座位，无手时 SB/BB 为 null。客户端使用共享协议字段，未增加座位 UI 或重复计算规则。

严格 wire 主版本提升到 v4，v3 及更早版本拒绝；HTTP 路径仍为 `/api/v1`。wire `snapshotVersion=1`、持久化 `schemaVersion=2` 和 `engineVersion=0.1.0` 各自独立，无迁移。前后端须同步发布或回滚。

## 验证矩阵

| 验收点 | 证据 |
| --- | --- |
| 必填、nullable、0–9 范围、非法类型与旧版本拒绝 | `packages/protocol/src/protocol.test.ts`；Web Transport / Gateway 的 v3 拒绝 |
| Heads-Up D=SB；3/6/10 人；连续三手移动 | `projection/blind-seats.test.ts`，固定随机源与显式首庄 |
| 非连续座位、撤回与真实全下淘汰 | 同一测试覆盖本手保留、下一手跳过和淘汰观战公开一致 |
| 逐事件 patch 与当前视图一致 | 每事件 `applyPlayerViewPatch(before, patch) == projectPlayerView(after)`；旧手事件 hand 与新 Tournament 庄位同时存在时仍取旧手 D/SB/BB |
| INITIAL / RECONNECT / RESYNC / FAST_FORWARD 无开手历史即可恢复 | 协议 Snapshot 验证、客户端 ProjectionStore；真实 Gateway 的 INITIAL、重连、GAP→RESYNC |
| 真实 HTTP/WS 与私有隔离 | `tests/clients/server-harness.test.ts`：开手事件、双玩家重连与 GAP Snapshot 对照，公开座位相同、本人底牌不同；所有入站消息严格 Schema 校验 |
| 实际持久化恢复与序列延续 | `blind-seat-recovery.test.ts`：生产 Executor → Bundle → PostgreSQL → RecoveryRepository → recoverActiveTournaments → 下一手 D/SB/BB，首事件为水位+1；原恢复 unit 亦对照恢复后的事件和投影 |

实际存储测试确认 Bundle `snapshot.state` 是字符串，SQL jsonb 类型是 string，而 Drizzle jsonb 映射后的 RecoveryRepository 返回对象；现有恢复读取可用，无额外解析或 Writer 修改。该事实同步 [03](../03-data-model.md) 和 [04](../04-game-server-architecture.md)。

## 命令与结果

环境：Node/pnpm，本机隔离 PostgreSQL 测试 schema，2026-09-12。先执行 `pnpm install --frozen-lockfile --offline` 与共享包 build。

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --project unit --project rules` | 79 文件、747 测试通过 |
| `pnpm exec vitest run --project ws` | 2 文件、11 测试通过，真实 HTTP/WS |
| `TEX_TEST_DATABASE_URL=... pnpm exec vitest run --project integration apps/game-server/tests/integration/recovery.test.ts apps/game-server/tests/integration/blind-seat-recovery.test.ts apps/game-server/tests/integration/hand-commit-bundle.test.ts apps/game-server/tests/integration/hand-history-read.test.ts` | 4 文件、39 测试通过，真实 PostgreSQL，无跳过 |
| `pnpm typecheck` | 通过，含根测试 TypeScript 校验 |
| `pnpm lint` | 通过；已有 `gateway-protocol.test.ts` unused `room` warning，0 errors |
| `git diff --check` | 通过 |

已有工具提示：Vitest/Vite 提示未来 native config loader；pg 提示未来 v9 的同 client 并发 query 弃用。与本任务无关，未捎带修改。

## 受影响浏览器 E2E 与基线对照

主 Agent 在联合验证工作树仅装载 TEX-53 代码时运行受影响 Playwright 用例（当时尚未合入 TEX-54，不作为其浏览器验收）：**27 项中 26 项通过、1 项失败，整体 E2E 未通过**。失败为 `tests/e2e/animation-audio/experience.spec.ts:7` 的“键盘调整音量和动态效果，刷新与牌桌音效开关共用持久偏好”。第 24 行断言发现动态效果原生 `<select>` 接收 `End → Enter` 后仍为 `system`，预期 `reduce`，等待 5 秒后失败。总运行耗时 28.3 秒，命令：

```bash
TEX_E2E_PORT=3154 CI=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts tests/e2e/betting/table.spec.ts tests/e2e/reconnect/tex-26.spec.ts --workers=2
```

失败产物位于 `/Users/szh/Documents/GitHub/Texas-Holdem-TEX-53-54-validation/tests/e2e/.artifacts/animation-audio-experience-2716f-键盘调整音量和动态效果，刷新与牌桌音效开关共用持久偏好/`。

为判断是否由本任务引入，在全新 detached 工作树检出干净 `upstream/main`（`56020cd2eab5811dba327349f66f703085aada04`），同一 macOS / Chromium 环境只执行该用例一次，未修改产品或测试，未重试。命令：

```bash
TEX_E2E_PORT=3155 CI=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts --grep '键盘调整音量和动态效果' --workers=1
```

基线结果：**1 项失败**，相同第 24 行、相同 `reduce` / `system` 差异，`consoleErrors=[]`、`pageErrors=[]`。失败产物保存在基线工作树 `/Users/szh/Documents/GitHub/Texas-Holdem-TEX-53-54-baseline` 内的 `tests/e2e/.artifacts/animation-audio-experience-2716f-键盘调整音量和动态效果，刷新与牌桌音效开关共用持久偏好/`，含 `trace.zip`、`test-failed-1.png`、`video.webm` 与 `error-context.md`。Next 自动生成的 `next-env.d.ts` 变化已恢复，基线工作树保持干净；未触及原工作区 `globals.css`。

该对照证明当前 macOS / Chromium 环境在未包含 TEX-53 时已有同样失败，没有证据将其归因于本任务。尚未确认其他操作系统是否同样失败；本记录保留失败，不将剩余用例通过或基线归因写成整体门禁通过。本任务未捎带修改设置页或键盘测试。

## 文档同步与交付边界

已更新受影响的 protocol、projection、gateway、persistence、客户端 state/transport、真实 WS 与 E2E fixture 目录 README；同步工程规格 01/02/03/04/06、ADR、任务总览和文档索引。隐私边界记录在 security 索引，未新增访问资格。

部署配置、运维命令和数据库迁移：已检查，无需更新；本任务未更改这些运行资产，同步发布/回滚要求已记录 ADR。前端 UI 规格：已检查，无需更新；只补协议消费和夹具，座位徽标属于后续任务。受影响 Playwright 夹具已补齐 wire v4 字段；联合受影响 E2E 为 26/27 通过，其 1 项失败及干净基线对照见上文，其余跨任务联合验收由主 Agent 汇总。

代码与本地验收已完成；推送、PR、Linear 状态与跨任务联合验收由主 Agent 统一闭环。本任务未收到需要回复的 PR 原始审查评论；未触发 Greptile 或 DeepSeek Harness。
