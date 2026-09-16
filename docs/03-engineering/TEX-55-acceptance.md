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
   - 扩展 `resultRows`，无缝适配 `GameSnapshot`（`stack`）与 `TournamentResult`（`finalStack`），排名严格按服务端 `displayOrder` 呈现，UI 绝不重排序。
   - 增加 `resultChampion`：当 `championPlayerId === null` 时，清晰标示“比赛结束，无冠军”，客户端不推断或捏造冠军。

---

## 验证矩阵

| 验证项 | 验证命令 / 测试文件 | 结果 |
| --- | --- | --- |
| HttpTransport 请求、Schema 校验与 Token 清理竞态保护 | `pnpm exec vitest run --project unit apps/web/src/protocol/http-transport.test.ts` | 13 项全部通过 |
| PlayerTokenStore `clearIfMatches` 原子校验 | `pnpm exec vitest run --project unit apps/web/src/protocol/token-store.test.ts` | 8 项全部通过 |
| ResultView 纯展示模型（快照、权威结果、并列、无冠军终局） | `pnpm exec vitest run --project unit apps/web/src/features/result/result-view.test.ts` | 10 项全部通过 |
| ResultFlow 数据源优先级、HTTP 恢复、多轮缓存隔离与 Abort 竞态 | `pnpm exec vitest run --project unit apps/web/src/features/result/result-flow.test.ts` | 5 项全部通过 |
| 仓库全量单元测试套件 | `pnpm test:unit` | 85 文件、859 项全部通过 |
| 全局代码类型检查 | `pnpm typecheck` | 全部包与测试通过，0 errors |
| 全局代码风格检查 | `pnpm lint` | 通过，无新增警告 |
| Next.js 与 Monorepo 生产构建 | `pnpm build` | 4 个 Package 全部构建成功 |
| 真实链路 Playwright E2E 验证（刷新、直接访问、新轮共存、未授权拦截、移动视口） | `tests/e2e/real/result-recovery.spec.ts` | 已就绪 |
| Git 差异规范检查 | `git diff --check` | 通过 |

---

## PR 审查意见与闭环说明

- 本任务在独立工作区 `C:\Users\34026\Texas-Holdem-TEX-55` 完成，新建分支 `feat/TEX-55-tournament-results-refresh-and-direct-access`。
- 遵循用户指令：**未执行 `git push`**。
- 文档同步：已同步更新 `apps/web/src/features/result/README.md`、`apps/web/README.md`、`docs/05-frontend-spec.md` 与本验收记录。
