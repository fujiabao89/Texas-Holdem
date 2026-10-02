# TEX-60 弱网行动时钟验收

日期：2026-10-02。任务：[TEX-60](https://linear.app/texas-holdem/issue/TEX-60/tex-60-修正弱网环境下的倒计时与操作提交公平性)。用户直接委派 Codex 实现、提交、推送及创建 PR；分支 `fix/TEX-60-network-fair-action-clock`，从已合入 TEX-59 的 main 开始。

## 范围与验收对应

| 条件 | 实现与证据 |
| --- | --- |
| 50/100/300/500ms RTT、抖动不明显高估可提交时间 | 四时间戳校时扣除服务端处理时间；EWMA 偏移/RTT、抖动与偏移残差构成安全余量。ServerClock 单元测试覆盖四档 RTT 及非对称抖动；浏览器受控时钟验证四档 RTT。 |
| 截止时间附近给出明确反馈 | 首次校时前关闭限时提交入口；安全窗口耗尽显示时间不足，提交 handler 再读单调时间；ACTION_TIMEOUT 明确说明到达时已超时并请求权威 Snapshot。客户端不产生自动弃牌。 |
| 重连不授予完整时间 | 锚点保存在投影入口，迟到消息与重挂载不能重启倒计时；断线 8 秒后原 30 秒截止显示剩余 22 秒，旧 sequence 的未知命令不重发，新机会使用新 actionId。 |
| 截止边界顺序可复现 | 网关通过 Schema 后、访问检查前固定 receivedAt；Executor 对 Action 与 Time Bank 比较 D-1/D/D+1、Timer-first/Action-first，校验结果和唯一自动事件。 |
| 单玩家弱网不暂停整桌 | 校时直接回复、不进入比赛队列、不推进 sequence、不改 deadline；测试验证运行时和时钟未变。探针失联进入既有重连流程。 |
| 幂等及提交状态闭环 | 继续使用原 requestId/actionId/expectedSequence；重连只重发原机会匹配的原字节，同步拒绝并发意图；Event-before-ACK 与 ACK-before-Event 都按 appliedSequence 回收。 |

权威契约见 [02 协议](../02-protocol-spec.md)、[04 服务端](../04-game-server-architecture.md)、[05 前端](../05-frontend-spec.md)、[06 测试](../06-testing-strategy.md)，决策见 [ADR-0006](../adr/0006-tex-60-network-fair-action-clock.md)，发布与诊断见 [运行说明](../05-operations/network-action-clock.md)。本记录仅列验收证据，不维护另一份契约。

## 实际验证

| 命令 / 检查 | 结果与边界 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；未改依赖清单或锁文件。 |
| `pnpm exec vitest run --project unit --maxWorkers 2` | 87 文件、923 项通过。 |
| `pnpm test:ws` | 2 文件、11 项通过。 |
| `pnpm test:rules` | 3 文件、32 项通过。 |
| `pnpm test:integration` | 13 文件、101 项跳过：未配置隔离 PostgreSQL，不作为集成通过证据。 |
| `pnpm lint` | 通过；既有 gateway-protocol.test.ts 的 unused room 警告保留（0 errors）。 |
| `pnpm typecheck` | 所有 workspace 及根测试类型检查通过。 |
| `pnpm --filter @texas-holdem/game-server build` | 通过。 |
| `pnpm --filter @texas-holdem/web build --webpack` | 最终修改后的生产构建通过，8 个路由生成成功。 |
| Playwright betting 的 TEX-60 专项 | 6 项通过：四档 RTT、显式超时、重连剩余时间与新旧意图隔离。 |
| Playwright animation-audio / seats / table-layout / reconnect 扩展批次 | 首次 186 项中 185 通过，6x CPU 用例超时，不能作为完整通过批次。 |
| 修正后的 Playwright 6x CPU 专项 | 1 项通过（45.3 秒）。将每 250ms 的刷新限制在 ClockStatus，操作区仅在安全窗口耗尽时更新；不限时没有倒计时 timer。未增加重试或放宽测试超时。 |

最后一轮 `animation-audio + betting --workers=1` 全部 36 项通过（3.4 分钟，禁用重试）；包含全部 14 个动画/音效用例及 22 个下注用例。修正后的 6x CPU 用例在该批次再次通过（9.4 秒，90 帧、平均帧间隔 22.4ms、P95 33.3ms）；这是该桌面模拟样本，不能外推为移动实机性能保证。其余 seats/table-layout/reconnect 共 172 项已在上述扩展批次通过。

`git diff --check` 通过；本次涉及 Markdown 的 396 个本地链接目标均存在。

浏览器验证使用 `TEX_E2E_PORT=3160`、`TEX_E2E_BASE_URL=http://127.0.0.1:3160`，复用 `pnpm --filter @texas-holdem/web dev --port 3160 --webpack`，Playwright 命令为 `pnpm exec playwright test -c tests/e2e/playwright.config.ts <目录> --workers=1`。本地默认 Turbopack 服务启动超过配置的 120 秒，因此使用已有 Webpack 入口；未更改测试配置、依赖、重试数或超时。投影 mock、受控浏览器时钟和桌面 Chromium CDP 模拟是本次证据边界，不等同于真实跨境链路或移动实机认证。

## 文档同步与剩余边界

- 协议、网关、执行器、Web 传输/状态/牌桌/文案、各受影响测试目录 README 已同步；测试夹具明确响应 TIME_SYNC，不隐藏新增契约。文档索引、权威规格、ADR 与运维说明在同一 PR。
- 产品规划、扑克引擎规则、数据模型和安全规范：已检查，无需更新。本任务不改变玩法、玩家权限、私有牌面投影、秘密配置或持久化；客户端时间戳仅回显，服务端裁决使用自身时钟。路线图仅增加本次验收链接，未改变优先级或后续范围。
- wire v6 必须前后端同步升级/回滚；无数据库迁移。无限非对称或未来突发延迟无法由有限样本保证，服务端错误和状态仍是最终结果。真实 PostgreSQL/公网完整链路尚未执行；慢客户端背压与完整端到端门禁分别由 TEX-61/TEX-62 承担。
- 未自动调用 DeepSeek Harness 或触发 Greptile；本任务未处理已有 PR 审查评论，无原评论线程待回复。交付进入 PR 审阅，不代表已部署或合并。
