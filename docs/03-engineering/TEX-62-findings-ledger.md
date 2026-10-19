# TEX-62 / PR #80 Findings Ledger

核验日期：2026-10-19。基线 `63f4cbdd4323c85d1376bc542d214970a7698137`；用户指定 [失败 job](https://github.com/fujiabao89/Texas-Holdem/actions/runs/39199775112/job/117890144672)，核对完整 Actions 日志、固定 SHA 的脱敏产物及当前协议/发送实现后作出处置。

| ID | 发现与精确失败场景 | 当前实现与既有覆盖核验 | 等级 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | 慢接收用例停读后无生产背压记录，35 秒轮询超时。认证预检成功，发送 47,771 探针含 11,943 个快照请求，服务端 SNAPSHOT_REQUESTED 为零。 | 压力分支漏发协议必填 lastSequence；validateClientCommand 在进入 REQUEST_SNAPSHOT 分支前拒绝，回复 INVALID_MESSAGE，未生成预期真实 Snapshot。原有代理、观察器与协议单测没有验证这段浏览器发送代码。将原发送逻辑提取后，以真实 ClientCommandSchema 检验，原码在 payload.lastSequence 明确失败；原生缓冲限制回归仍通过。 | P1 | 确认阻塞门禁：补齐已观察 sequence；同一发送函数由 E2E 与 Schema 回归共用，并以共享 ClientCommand 类型约束。保留 65,536 探针、256KiB 缓冲、生产背压及恢复/隔离断言和零重试。 |
| F-02 | 日志尾部重复 database tex_test does not exist。 | service 健康检查 pg_isready 省略数据库而使用用户名作为默认库；实际测试使用 tex_e2e，迁移、全部 20 项和 teardown 均已运行，另外 19 项通过。不是本次断言失败原因。 | P3 | 跳过：健康检查输出噪声，当前任务不捎带修改所有既有 Workflow。 |
| F-03 | 场景 teardown 打印 launcher 的 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL。 | timeline teardown 按 schema/PID 终止自有服务端并删除 schema；split/background 通过时也打印同样信息，失败断言发生在此前慢接收用例。 | P3 | 跳过：不属于运行中服务端崩溃，不以屏蔽 teardown 输出替代修复。 |
| F-04 | 修复合法压力请求后，恢复突发 Snapshot 导致 pageerror React 185。 | 本地真实链路仅 768 探针即接受 192 个快照并触发一次背压，随后 UI 报更新深度超限。独立 256 个同序列 Snapshot 浏览器回归在旧 production 代码上确定产生四次 React 185。倒计时和行动窗口 hooks 对每个新 clock 对象立即在 effect 中写入派生状态，造成同步更新链；既有时钟/恢复测试没有连续快照突发。 | P1 | 确认阻塞真实恢复：只调整两个计时 hooks，渲染直接读取当前权威 clock，保留原有截止、250ms 倒计时刷新及可见性更新；移除每个 Snapshot 后的即时派生状态写入。不批量丢弃 Snapshot，不改 deadline、校时或提交安全余量。为完成有效压力场景，这一最小产品修复随本 PR 交付。 |

验证和固定提交的集成结果见 [实施卡](../00-project/TEX-62-regression-gate.md)。本任务来自 Actions 失败，无对应原始 inline 审查线程；不向无关审查评论回复“已修正”。
