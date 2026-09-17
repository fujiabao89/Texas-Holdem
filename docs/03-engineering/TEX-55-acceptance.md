# TEX-55 赛果页权威接口刷新与直接访问验收

- 日期：2026-09-16
- 分支：`feat/TEX-55-tournament-results-refresh-and-direct-access`
- 对应 Linear 任务：[TEX-55](https://linear.app/texas-holdem/issue/TEX-55/tex-55-让赛果页通过权威接口支持刷新与直接访问)
- 权威依据：[ADR-0004](../adr/0004-tex-54-persisted-tournament-result.md)、[05-frontend-spec.md](../05-frontend-spec.md) §6.6 / §12 / §14 / §16

---

## 交付与验收

1. **HttpTransport 权威接口接入**：
   - 在 `HttpTransport` 接入 [TEX-54] 的 `GET /api/v1/tournaments/{tournamentId}/result` 严格 Schema。
   - 增加 `getTournamentResult(tournamentId, roomId, requestOptions)` 方法，自动注入 `Authorization: Bearer <token>` 请求头。
   - 修复 TEX-34 约束与竞态保护：在收到 `AUTH_FAILED` 或 `INVITE_EXPIRED` 时，调用 `tokenStore.clearIfMatches`，仅当当前存储凭证依然等于本次请求被拒凭证时才清理，杜绝并发更新凭证被迟到响应覆盖误删。

2. **双重数据源优先级与本地缓存隔离**：
   - 内存快照优先（Fast Path）：牌桌终局后跳转赛果页，若当前 `state.game` 匹配 URL `tournamentId` 且为 `FINISHED`，立即展示无网络等待。
   - 权威 HTTP 恢复（Recovery Path）：当用户刷新页面或直接通过 URL 访问赛果页时（内存快照为空或不匹配），自动调用 `http.getTournamentResult` 从服务端恢复权威持久化赛果。
   - 多轮共存与隔离：赛果按 `tournamentId` 字典隔离缓存于组件状态；房主在赛果页点击“再来一局”开启新比赛（`room.status` 变为 `IN_GAME`）后，打开旧赛果页面的其他标签页依然稳定展示旧比赛数据，不与新比赛的实时快照混合。

3. **请求竞态与 Abort 控制**：
   - 每次 HTTP 获取赛果均挂接 `AbortController`；URL `tournamentId` / `roomId` 切换或组件卸载时立即中止未完成请求。
   - 响应处理带有取消与活跃守卫，迟到的旧比赛响应绝不覆盖当前赛果或清空更新后的凭证。

4. **状态细化与中文错误分支**：
   - 身份失效 / 未授权：展示 `errorMessage("AUTH_FAILED")`，清除无效 Token 并提供“加入房间”导航。
   - 比赛未找到（404）：展示 `errorMessage("TOURNAMENT_NOT_FOUND")`（“未找到该场比赛，或赛果已过保留期。”），提供“返回大厅”导航。
   - 比赛未完成（409）：展示 `errorMessage("TOURNAMENT_NOT_FINISHED")`（“本场比赛尚无已完成的赛果。”），提供“前往牌桌”与“返回大厅”导航。
   - 赛果同步中 / 临时不可用（503 / 429 / 网络超时）：展示对应提示并提供“重试”按钮，支持就地重发请求。
   - 加载中：展示 `message("result.loading")`，配合 `aria-live="polite"` 无障碍提示。

5. **展示模型与 ADR-0002 无冠军终局支持**：
   - 扩展 `resultRows`，无缝适配 `GameSnapshot`（`stack`）与 `TournamentResult`（`finalStack`）。
   - 修复排序键缺陷：排名排序先按 `placement.from` 升序再按 `displayOrder` 升序，彻底解决仅按 `displayOrder` 导致后续名次穿插进并列组的问题。
   - 修复无冠军快路径虚构冠军缺陷：`GameSnapshot` 严格根据 `pokerStatus === "ACTIVE"` 数量与第 1 名权威排名识别冠军；若无唯一 ACTIVE 玩家（如无人获胜终局），快路径返回 `hasChampion: false`，两通道展示严格一致。
   - 修复 `canPlayAgain` 状态：仅在 `FINISHED` 或 `LOBBY` 且为房主时返回 `true`，`IN_GAME` 期间严格返回 `false`，杜绝向服务端发起必定被拒的开局命令。

6. **凭证安全防护边界**：
   - 仅在 HTTP 请求路径直接以 Room 为目标（`/api/v1/rooms/:roomId...`）且返回 `AUTH_FAILED` / `INVITE_EXPIRED` 时经 `clearIfMatches` 清除 Token。
   - 跨资源查询的 `GET /api/v1/tournaments/:tournamentId/result` 即使被服务端拒绝，也绝不误清本地有效 Room Token，彻底防范恶意错配 URL 导致玩家丢失匿名凭证。

---

## 审查意见复核处置清单（Review Findings Ledger）

| 编号 | 级别 | 审查意见摘要 | 处置依据与实现 | 验证用例 |
| --- | --- | --- | --- | --- |
| F-1 | P1 | 无冠军快路径会虚构冠军（GameSnapshot 无 championPlayerId 时误将 placement.from===1 当冠军） | 新增 `snapshotChampionPlayerId`，严格校验唯一 ACTIVE 玩家且排名为 1-1（displayOrder=1）；无 ACTIVE 玩家时两通道一致呈现“无冠军” | `result-view.test.ts`（tied 终局 hasChampion===false 断言） |
| F-2 | P1 | displayOrder 不是全局排序键（仅按 displayOrder 排序会把并列组打乱） | 排序统一采用 `(left.placement.from - right.placement.from) || (left.displayOrder - right.displayOrder)` | `result-view.test.ts`（并列与后续名次穿插排序断言） |
| F-3 | P1 | 可由错配 URL 清除有效房间凭证（/room/A/result/B-tournament 导致清除 A 的 Token） | `HttpTransport` 增加 `isDirectRoomResource` 防护门禁，非 `/api/v1/rooms/:roomId` 路径收到 AUTH_FAILED 不清 Room Token | `http-transport.test.ts`（tournament URL AUTH_FAILED 保护 Room Token 断言） |
| F-4 | P1 | 新标签页直接访问用例必然缺少凭证（sessionStorage 跨 tab 隔离导致 newPage 失败） | E2E 改为在原 Tab 验证同会话直接导航，新独立 context 验证未认证安全拦截，Bob 真实 context 验证下一轮后旧赛果稳定隔离 | `tests/e2e/real/result-recovery.spec.ts` |
| F-5 | P2 | canPlayAgain 在 IN_GAME 时仍返回 true | `canPlayAgain` 限制为 `roomStatus === "FINISHED" || roomStatus === "LOBBY"` | `result-view.test.ts`（IN_GAME 返回 false） |
| F-6 | P2 | 文档完成定义未闭合（protocol/README、tests/e2e/README 与 docs/06 缺漏） | 同步更新 `apps/web/src/protocol/README.md`、`tests/e2e/README.md`、`docs/06-testing-strategy.md` 并更新工程索引 | 本文档及相关 README |

---

## 验证矩阵

| 验证项 | 验证命令 / 测试文件 | 结果 |
| --- | --- | --- |
| HttpTransport 请求、Schema 校验、直接资源判定与 Token 清理竞态保护 | `pnpm exec vitest run --project unit apps/web/src/protocol/http-transport.test.ts` | 14 项全部通过 |
| PlayerTokenStore `clearIfMatches` 原子校验 | `pnpm exec vitest run --project unit apps/web/src/protocol/token-store.test.ts` | 8 项全部通过 |
| ResultView 纯展示模型（快照、权威结果、并列排序、无冠军终局、状态准入） | `pnpm exec vitest run --project unit apps/web/src/features/result/result-view.test.ts` | 12 项全部通过 |
| ResultFlow 数据源优先级、HTTP 恢复、多轮缓存隔离与 Abort 竞态 | `pnpm exec vitest run --project unit apps/web/src/features/result/result-flow.test.ts` | 5 项全部通过 |
| 仓库全量单元测试套件 | `pnpm test:unit` | 85 文件、862 项全部通过 |
| 全局代码类型检查 | `pnpm typecheck` | 全部包与测试通过，0 errors |
| 全局代码风格检查 | `pnpm lint` | 通过，无新增警告 |
| Next.js 与 Monorepo 生产构建 | `pnpm build` | 4 个 Package 全部构建成功 |
| 真实链路 Playwright E2E 语法与场景规范 | `tests/e2e/real/result-recovery.spec.ts` | 已更新并通过静态检查 |
| Git 差异规范检查 | `git diff --check` | 通过 |

---

## PR 审查意见与闭环说明

- 本任务在独立工作区 `C:\Users\34026\Texas-Holdem-TEX-55` 完成，新建分支 `feat/TEX-55-tournament-results-refresh-and-direct-access`。
- 遵循用户指令：**未执行 `git push`**。
- 文档同步：已同步更新 `apps/web/src/features/result/README.md`、`apps/web/README.md`、`apps/web/src/protocol/README.md`、`tests/e2e/README.md`、`docs/06-testing-strategy.md`、`docs/05-frontend-spec.md`、`docs/03-engineering/README.md` 与本验收记录。
