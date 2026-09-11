# TEX-40 / PR #44 Findings Ledger

复核日期：2026-09-09。基线：PR #44 head `a66f493c`（本台账条目均针对该提交的当前代码逐条核验）。来源为 GitHub 全部行级审查线程（7 条，Codex 5 + Greptile 2）与 PR Conversation 摘要；未启动 Greptile、Codex 或 DeepSeek Harness 新审查。本轮只修复确认阻塞本 PR 的问题，保持最小改动、不做无关重构。

## 逐条核验

| ID | 来源 | 有效性、精确场景与现有覆盖 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | [Codex 3974956361](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974956361) | 有效。`unpackTarball` 在解包后把 `manifest.json` 写入 release 目录，而 `rootDigestSha256` 是构建时对不含该文件的 stage 计算的；`verifyReleaseDir` 直接散列整个 release 目录，因此**任何**合法 artifact 都会在 `verify-unpacked` 失败——`deploy --apply` 无法到达迁移/激活，回滚校验同样必失败。既有单测未覆盖“解包后目录含部署侧 manifest”的执行路径。 | P1 | 修复：`computeTreeDigest` 增加 `exclude` 选项；新增 `releaseTreeDigest(dir)` 以 `exclude:["manifest.json"]` 计算，`verifyReleaseDir` 改用它，校验范围与构建时一致。新增单测：含 manifest 后摘要不变、未排除时摘要改变（复现原缺陷）。 |
| F-02 | [Codex 3974956368](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974956368) | 有效。候选已启动后若 health 或激活失败，`restoreOldTarget` 只调用 `serviceCtl("start")`；对运行中的 unit，`systemctl start` 是 no-op，候选进程继续服务并会让随后的 health 误判为“已恢复旧版”，而脚本报告回滚成功。 | P1 | 修复：恢复路径改用 `RECOVERY_SERVICE_VERB = "restart"`（可覆盖“候选仍在运行”；对已停止单元等价启动），并更新失败提示。新增断言锁定该动词。 |
| F-03 | [Codex 3974956372](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974956372) | 有效。`deploy` 有 `SERVICE_CONTROL=none` + 已有当前版本的安全拒绝，`execRollback` 没有：该模式下 stop/start 均为 no-op，只切换 `current` 后探测**未改变的旧进程**，若其健康就把目标 SHA 记为 current 并报成功——虚假运行与状态记录。 | P1 | 修复：新增 `assertRollbackServiceControl(cfg)`，`execRollback` 立即调用；`none` 拒绝并提示 TEX-41/用户需配置 systemctl/docker。新增单测（none 抛错、systemctl 通过）。 |
| F-04 | [Codex 3974956377](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974956377) | 有效。`unpack` 之后任何失败（部分解包/迁移/启动/health）都会留下 `releases/<sha>`，而下次尝试因“目录已存在（不可变目录拒绝覆盖）”永久失败；瞬时 DB/服务故障会阻塞同一不可变 artifact 的重试，需人工删除。 | P2 | 修复：`execDeploy` 记录 `activated`；失败且未激活时在恢复运行目标后清理候选目录（`removeTree` 容错）。已验证的 release 目录与已激活版本不受影响。 |
| F-05 | [Codex 3974956380](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974956380) | 有效。`activate` 写入 `state.json` 后紧接的审计追加若失败（审计目录不可写/磁盘满），外层 catch 会回切运行目标却**不回滚 state**，造成 `state.current` 指向候选而旧版本在运行；后续回滚选择与 journal 前缀检查会依据错误状态。 | P2 | 修复：`appendAudit` 改为非致命——写入失败只输出告警，不再触发对已激活部署的回滚。 |
| F-06 | [Greptile 3974962830](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974962830) | 与 F-01 完全相同的缺陷（同一行、同一失败场景），仅表述与复现产物不同。 | P1 | 合并到 F-01，跳过重复实现；单独回复原线程。 |
| F-07 | [Greptile 3974962832](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3974962832) | 与 F-03 相同的缺陷（`SERVICE_CONTROL=none` 回滚假成功）。 | P1 | 合并到 F-03，跳过重复实现；单独回复原线程。 |

未计入缺陷的 Conversation 项：CodeRabbit 仅为“仓库未启用自动审查”的配置说明与提示（无行级 finding）；Qodo 因试用额度暂停审查；Vercel 为部署状态通知；`linear-code` 为 TEX-40 关联链接。均非代码缺陷。

## 验证

- 修改前：F-01 场景下 `deploy --apply` 在 `verify-unpacked` 必然失败（release 目录摘要含部署侧 manifest）；F-03 场景下 `rollback` 可记录错误的运行版本。
- 修改后定向单测：`node --test "infra/deployment/tests/**/*.test.mjs"` —— **16/16 通过**（原 13 + 新增 3：摘要排除 manifest、恢复动词 restart、none 回滚拒绝）。
- `node --check` 全部脚本通过；`git diff --check` 干净。
- 远端 CI（修复提交 `3ef3d54a`）：**Release artifact** [run 34430869032](https://github.com/fujiabao89/Texas-Holdem/actions/runs/34430869032) ✅（构建 → tarball SHA/解压摘要校验 → 隔离 HTTP/WS smoke → 正式上传）；**PR Policy** ✅；**Dependency Review** ✅；[CI run 34430869011](https://github.com/fujiabao89/Texas-Holdem/actions/runs/34430869011) 的 `repository-hygiene`/`quality`/`workflow-lint`(actionlint)/`perf-smoke`/`e2e` 均 ✅。
- **独立于本任务的既有失败**：同一 CI run 的 `e2e-real` 为可复现失败（重跑仍失败）——日志显示 game-server 进程因持久化层未处理的 `pg` 连接错误退出（`terminating connection due to administrator command` → pool 错误 → `launch-game-server.ts` 退出码 1），随后 webkit 用例因服务不可达而超时。该崩溃发生在 `apps/game-server` 持久化路径，**不涉及本 PR 改动面**；本台账不将其计为 TEX-40 审查 finding。
- **e2e-real 取证与收敛（提交 `4de63f3b`）**：本地以同代码复现——单工程 webkit 无障碍用例通过（2.8m），firefox+webkit 并发 8/8 通过（webkit 无障碍 55.2s / firefox 27.1s），全量并发 14 passed（唯一失败为 firefox `multiplayer-journey` 的 `toHaveURL`，与本任务无关）。结论：CI 上三个浏览器工程并发 + Next dev 冷编译使 WebKit 建房→大厅超过原 30s 等待（非逻辑失败；本地更快的机器 55s 即通过）。处置：把 `accessibility.spec.ts` 与共享 helper `support/ui.ts` 的“房间大厅”可观察等待放宽到 150s、无障碍用例总时长 300s（仍为可观察就绪断言，非 sleep）。末尾 `[WebServer] terminating connection ...` 为 `global-teardown` 在用例结束后 `pg_terminate_backend`/DROP SCHEMA 的收尾痕迹，非失败原因。
- 最终 CI（提交 `4de63f3b`）：`repository-hygiene`/`quality`/`workflow-lint`(actionlint)/`perf-smoke`/`e2e`/**`e2e-real`** 全部 ✅。

## e2e-real webkit 超时：原诊断被证伪与真实根因

提交 `00f91b64` 仅改本台账，CI `e2e-real` 再次失败（[run 34435054935](https://github.com/fujiabao89/Texas-Holdem/actions/runs/34435054935)），证明**上一条「WebKit 渲染慢」的结论不成立**——同一代码在 `4de63f3b` 通过、在仅改文档的 `00f91b64` 失败，是 flake 而非回归，且放宽等待到 150s 后仍复现。

本地复现（`--project=webkit -g "双人完整锦标赛"`）并取证，推翻原诊断：

- 失败断言落在 `support/ui.ts` 的「房间大厅」等待；`requests` 中**完全没有** `POST /api/v1/rooms`，`consoleErrors` 与 `pageErrors` 均为空。
- trace 显示 `fill("玩家甲")` 已写入（该节点 `__playwright_value_` 有值），但失败截图里「昵称」为空且被浏览器聚焦——即 HTML5 校验拦截了提交。
- 真实根因：**React 水合竞态**。Next dev 下表单首屏可见早于水合完成；若 `fill` 发生在水合之前，其 `input` 事件没有 React 监听者，组件 state 保持初值，水合提交随后把受控输入的 DOM 值同步回 state，清空用户输入。接着 `required minLength=2` 的表单校验静默阻止提交：不发请求、不导航、浏览器零报错，表现为等待大厅超时。三个浏览器中 WebKit 水合最慢，故只在该工程暴露；同一次运行内先填的文本字段被清空、后填的数字字段（水合后）保留，与截图完全吻合。**该状态是永久卡死而非渲染缓慢**，因此放宽超时在原理上不可能修复。

处置：`support/ui.ts` 在点击提交前对账受控输入（`commitVerifiedForm`），被水合清空则重新填入——重试而非固定等待，水合完成后填入的值稳定保留，循环必然收敛；断言仍挂在可观察状态上（docs/06 §5，未引入 sleep 或 route 伪造）。`createRoomViaUi` 与 `joinViaUi` 均覆盖，公开签名不变。

未改动 `apps/web` 产品代码：真实用户在极慢水合下同样会丢失输入，属产品层面的既有边界；本次只消除测试对水合时序的隐含依赖，产品侧输入保活如需处理应单独立项。

## 文档与范围

`infra/deployment/README.md` 同步“回滚必须有服务控制（`none` 仅用于首装）”“恢复使用 restart”“release 目录校验排除部署侧 manifest”。未改动业务逻辑、扑克规则、协议、Nginx、数据库 schema/SQL 迁移或监控实现；未执行无关重构。

## 原线程闭环

修复提交推送后，以下 7 个原始线程均已回复；重复项指向规范线程。

| Finding | 原线程内的回复 | 结果 |
| --- | --- | --- |
| F-01 | [3975006214](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975006214) | 已修正、已 resolved |
| F-02 | [3975006341](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975006341) | 已修正、已 resolved |
| F-03 | [3975006541](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975006541) | 已修正、已 resolved |
| F-04 | [3975006716](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975006716) | 已修正、已 resolved |
| F-05 | [3975007238](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975007238) | 已修正、已 resolved |
| F-06 | [3975007088](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975007088) | 重复项，已随 F-01 修正、已 resolved |
| F-07 | [3975006874](https://github.com/fujiabao89/Texas-Holdem/pull/44#discussion_r3975006874) | 重复项，已随 F-03 修正、已 resolved |
