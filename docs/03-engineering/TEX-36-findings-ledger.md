# TEX-36 / PR #30 Findings Ledger

复核日期：2026-09-03。基线：`0ace1873c9b3d7732fa3bdca37c4d8dcda7d0f6c`。来源为 GitHub 全部审查线程（9 条，分页已遍历）与 PR Conversation/审查摘要；未启动 Greptile、Codex 或 DeepSeek Harness 新审查。本轮只修复确认阻塞本 PR 的问题。

## 逐条核验

| ID | 来源 | 有效性、精确场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Codex 3921822769](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921822769) | 有效。数据库保留历史凭证时，授权查询未检查 Room/成员状态，与协议 §5 的有效期冲突。原集成测试只测不存在/无效 token 与非参赛者；新增状态转换测试在修改前返回 200，预期 401。 | P1 | 修复：同一授权查询仅选择未关闭 Room 的 ACTIVE 成员；无效凭证按现有协议返回 `401 AUTH_FAILED`，不采用建议中的固定 403。FINISHED 未关闭房间的合法读取继续通过。 |
| F-02 | [Codex 3921822772](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921822772) | 有效。已提交事件被删除或序列损坏后，逐事件 Schema 仍可通过。Writer 保证提交时连续，但不保证之后的损坏被读取端拒绝。新增首/中/末事件删除、hand_sequence 缺口及全局 sequence 缺口用例，修改前全部错误返回 200。 | P2 | 修复：校验本手 1..N、全局相邻 +1、末序列与提交 Snapshot 对齐；后者同时发现尾部缺失。保持损坏响应为不含内部细节的 500。 |
| F-03 | [Codex 3921822778](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921822778) | 有效。真实执行器在手间背压暂停时撤回玩家，再恢复下一手，前导撤回被提交到下一手 Bundle。原路由把它标为下一手 ID，`hand-timeline.ts` 因此先进入 Result；既有时间线测试只测手内撤回。 | P2 | 修复：保留全部事件及连续序列，HAND_STARTED 前的事件信封使用既有 nullable `handId: null`；前端不把无手归属事件放入本手时间线。真实运行时→PG→HTTP 与前端纯函数分别验证。 |
| F-04 | [Codex 3921822783](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921822783) | 有效。重复 limit/cursor 在 Fastify 中成为数组，被当作缺省值；既有测试仅覆盖单值非法输入。新增重复参数请求在修改前返回 200，违背本 PR 的明确参数验收。 | P2 | 修复：只允许 undefined 或单一字符串，其他值返回 `400 INVALID_MESSAGE`。虽来源标为 P3，本次因明确验收不符列为 P2 阻塞。 |
| F-05 | [CodeRabbit 3921835512](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921835512) | 内容有效，但与 F-04 完全相同。 | P2 | 合并到 F-04，跳过重复实现；仍单独回复原线程。 |
| F-06 | [CodeRabbit 3921835529](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921835529) | 缺少 `Cache-Control: no-store` 属实；“当前客户端切换身份复用他人底牌”未复现。HttpTransport 使用默认 fetch，无 force-cache；服务端未提供 freshness/ETag/Last-Modified。使用真实路由、合成凭证和同一 Chromium 会话执行 A→B→A 两轮，6 次均到达授权查询，各响应只含当前接收者牌面。既有双身份 PG 测试亦验证投影隔离，但不证明所有浏览器的缓存行为。 | P3 | 跳过：非阻塞的防御性加固建议，当前没有可复现的跨身份缓存失败。此结论限于当前传输配置与已验证 Chromium；若引入 freshness、Service Worker 或其他缓存策略应重新核验。未修改缓存行为。 |
| F-07 | [CodeRabbit 3921835543](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921835543) | 内容有效，与 F-01 重复。要求 403 的具体建议与现有失效凭证 `AUTH_FAILED`→401 映射不符。 | P1 | 合并到 F-01，跳过重复实现和 403 建议；单独回复原线程。 |
| F-08 | [Greptile 3921836397](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921836397) | 有效，但两名真人全撤回后房间 CLOSED 的原示例会被 F-01 拒绝，不能据此要求继续开放历史。进一步验证了真实可读场景：先有一人淘汰留房，另两名活动玩家在同一手撤回，运行时/Bundle 标为 FINISHED，合法观战者读最后一手得到 500。原投影把 null 冠军转为空 ID；无已排名者时 min(1) 亦不兼容。旧测试没有此场景。 | P2 | 修复：见 [ADR-0002](../adr/0002-tex-36-championless-history.md)，唯一必要的共享协议例外；显式 null 冠军、可为空的无冠军排名，wire v3，客户端显示“无冠军”。不修改 Engine、写入或排名逻辑。角落场景读取失败，降为 P2。 |
| F-09 | [Greptile 3921836404](https://github.com/fujiabao89/Texas-Holdem/pull/30#discussion_r3921836404) | 有效，与 F-04 重复；身份鉴权仍执行，影响限于非法分页输入，并非 P1 主流程/授权故障。 | P2 | 合并到 F-04，跳过重复实现；单独回复原线程。 |

Conversation [CodeRabbit 5521648393](https://github.com/fujiabao89/Texas-Holdem/pull/30#issuecomment-5521648393) 的两项分别重复 F-01/F-04；CodeRabbit review body 的三项重复 F-04/F-06/F-01；PR 描述中的 Greptile “Comments Outside Diff”两项重复 F-08/F-09，不另计缺陷。Qodo 仅报告额度停用，没有审查 finding。

## 验证

- 修改前：新增 PG 状态/分页/连续性回归暴露错误 200；真实手间事件错误归属下一手；真实无冠军 FINISHED 历史返回 500。
- 修改后定向验证：`pnpm exec vitest run --project integration apps/game-server/tests/integration/hand-history-read.test.ts`，真实 PostgreSQL 16 隔离 schema，14 项通过；协议与时间线定向单元测试 28 项通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：全部通过。
- `TEX_TEST_DATABASE_URL=<本地隔离测试库> pnpm test`：68 文件、632 项通过，包含 unit/rules/integration/ws 四层；没有跳过数据库集成层。
- `CI=true TEX_E2E_PORT=3137 pnpm test:e2e --workers=2 --reporter=list`：27 项通过（41.4 秒，retries=0；3 个 observability 门禁用例按设计预期失败，计入成功自测）。
- 同一 Chromium 会话的实际路由缓存诊断：两轮 A→B→A 共 6 次授权查询、6 个正确接收者响应；使用合成凭证，无真实玩家数据。仅验证当前默认 fetch，不外推其他缓存配置。
- CI 与评论闭环结果在推送后确认；以上是本地可复现验证记录。

## 文档与范围

目录 README、协议/前端/测试规格与 ADR 同步；工程索引收录本台账。原“房间关闭后仍可读取”的说明与有效凭证权威规格冲突，按协议 §5 / 数据模型 §5.10 修正，不扩大 token 生命周期。产品目标、路线图、扑克规则、数据库写入/迁移已检查，无需更新：仅修复读取正确性与协议对既有终局的表达。发布需 Web/game-server 同时升级 v3，见 ADR；无关历史文档不逐份重写。

## 原线程闭环

推送前不得宣称已修正或已闭环。F-01/02/03/04/05/07/08/09 在验证、提交并推送后分别回复“已修正”；F-06 原线程回复未复现及非阻塞依据。回复完成状态将在推送后补记。
