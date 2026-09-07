# TEX-38 / PR #40 Findings Ledger

审查范围：PR #40 的当前分支 `feat/TEX-38-optimize-animation-and-audio`。本记录逐项核验已发布的 Copilot、Codex、CodeRabbit 和 Greptile 结果；不主动触发新的审查。严重度按实际用户影响与合并风险判定。

| ID | 来源 / 留言 | 有效性、精确失败场景与现有覆盖 | 严重度 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | Copilot [`3943527093`](https://github.com/fujiabao89/Texas-Holdem/pull/40#discussion_r3943527093)：成功截图目录不存在 | 无效。`captureTableEvidence` 实际在全量 E2E 的每个 TEX-38 场景执行；PR 的干净 GitHub Actions `e2e` 已通过，证明 Playwright `page.screenshot({ path })` 会为该 path 创建父目录。当前本地成功运行也产生 `output/playwright`。因此不存在“目录不存在导致测试失败”的场景。 | P3 | 跳过：已由干净 CI 与现有 11 个调用路径处理；不加入冗余目录创建。 |
| F-02 | Copilot [`3943527101`](https://github.com/fujiabao89/Texas-Holdem/pull/40#discussion_r3943527101)：E2E README 的段落缺少 list marker | 无效/风格。该段位于完整 bullet list 的空行之后，是独立有效 Markdown 段落，渲染和链接均正确；不影响测试、产品或文档事实。 | P3 | 跳过：纯排版偏好，不做无关改动。 |
| F-03 | Codex [`3946477292`](https://github.com/fujiabao89/Texas-Holdem/pull/40#discussion_r3946477292)：同一 accepted action 抢占当前回合提醒 | 有效。`useTableCues` 的订阅先于 presentation，若 `PLAYER_CALLED`/`PLAYER_BET` 令 viewer 成为当前行动者，`playTableCue` 会先播放并清空提醒；随后该 event 的 `playEvent` 调用会停止提醒，且旧实现不会保留重试。既有跨 controller 与“event 先、reminder 后”测试未覆盖此订阅顺序。 | P2 | 已修正：仅在提醒被本 controller 的后续事件抢占且仍在 900ms 新鲜窗口内时保留；事件 cue 结束后再播放。新增 `audio-controller.test.ts` 同事件顺序回归。 |
| F-04 | Codex [`3946477294`](https://github.com/fujiabao89/Texas-Holdem/pull/40#discussion_r3946477294)：慢帧 E2E 只记录自动减少动态状态 | 非阻塞测试建议。`FrameHealth` 的单元测试已确定性覆盖“24 样本中至少 6 次超过 34ms”才降级的阈值；6× CDP 限速并不保证任意机器在单个短 Overlay 中产生该次数。实际核验时 90 个 rAF 样本完成但页面保持 `data-reduced-motion="false"`，因为该环境未达到产品阈值；强制断言会把符合设计的高性能/低负载机器变成 flaky failure。 | P3 | 跳过：保留 rAF 报告、终帧与操作断言；确定性降级逻辑由现有 `frame-health.test.ts` 覆盖。 |
| F-05 | CodeRabbit | 无具体 finding。该 PR 的 CodeRabbit 自动审查因仓库少于 10 stars 被配置跳过；其状态成功不代表额外代码意见。 | — | 无需变更。 |
| F-06 | Greptile | 无具体 finding。Greptile Review check 已成功完成，但未创建 review、inline comment 或 issue comment。 | — | 无需变更。 |
| F-07 | 本轮验证：6× CPU E2E 固定要求 3 个飞牌节点 | 有效。真实慢机上 `FrameHealth` 可在 Playwright 查询前完成减少动态并提交正确公共牌终态；原测试仍硬性要求 3 个 flight DOM 节点，造成与产品降级契约冲突的 flaky failure。既有最终公共牌和下注断言仍覆盖正确终态。 | P2 | 已修正：该步接受“3 个可见 flight”或 `data-reduced-motion="true"`；后续继续断言可下注、无 flight 残留、3 张公共牌及真实 rAF 报告。 |
| F-08 | CI `e2e-real` #202 / WebKit axe：Ready 座位文字颜色对比度不足 | 有效。TEX-38 新增的 `lobby-seat-feedback` 从 `opacity: 0.45` 起始；玩家刚准备、座位以新 key 挂载而 axe 在动画窗口内扫描时，文字会与 `bg-emerald-50` 混合为约 `#979797` / `#b1b1b1`，对比度仅 2.84 / 2.09。现有真实链路 axe 门禁正确检出，但此前没有覆盖动画中间帧。 | P1 | 已修正：入场反馈只保留 transform 位移，不再改变文本不透明度；视觉节奏和 Reduced Motion 路径不变。 |
| F-09 | CI `e2e-real` #202 / Firefox 多人旅程：新比赛的非当前玩家未命中“等待”或“弃牌”选择器 | 有效的测试缺陷，非牌局或动画行为缺陷。第二局开始后，非当前玩家正确看到 `当前行动：<玩家名>` 与行动 deadline；`table.waiting` 仅在没有 deadline 时渲染，故既不会有“等待其他玩家行动”，也不会有其本人的弃牌按钮。原测试未覆盖这个合法状态，且 CI 已在该场景超时。 | P2 | 已修正：断言改为接受服务端权威的“当前行动”显示或当前玩家的弃牌按钮，仍验证双方已经收到第二局行动状态。 |

审查线程的既有回复在此前修复提交推送后完成；本次 CI 发现并非审查线程，无需回复。除 F-08 外，未发现 P0/P1、安全、授权、数据完整性或协议语义问题。
