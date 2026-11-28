# TEX-56 实机多人复玩验收记录

日期：2026-11-03（Asia/Shanghai）。任务：[TEX-56](https://linear.app/texas-holdem/issue/TEX-56)。用户委派 Codex 执行验收；分支 `test/TEX-56-multiplayer-device-acceptance`。本次仅整理验收资产、核验现有证据与执行既有门禁，不修改产品实现。

**当前结论：待实机验收，不能标记完成；发布建议 No-Go（证据未齐，不代表已发现产品缺陷）。** 至少三名真人、Android/iPhone 实机、两轮比赛及第二轮新人尚未提供记录。执行步骤见 [实机运行手册](../../tests/e2e/manual/README.md)，标准引用 [05 §16](../05-frontend-spec.md#16-验收标准前端侧) 和 [06 §9～§12](../06-testing-strategy.md#9-ui-e2e-与人工验收)。

## 候选与环境

| 项目 | 已核验事实 / 待填内容 |
| --- | --- |
| 自动化基线 | 当前 `origin/main`：`d675f726821c5f54c1afd97d37b6be1f2c9a8b3f`（TEX-49 PR #85 合并提交）；未获确认为实机测试部署候选 |
| 基线 lockfile SHA-256 | `9d01199467b8ebd3277bb6623e94cefe60dba39fc64aba703b75e3db2c920c4f` |
| 实机 Web / API URL | 待用户指定测试环境；不能默认向生产建房执行验收 |
| 实际 Web / game-server SHA | 待部署者核实，需匹配候选与兼容协议 |
| 部署配置版本 / 数据库隔离标识 | 待填；不填写连接串、凭证或真实用户数据 |
| 公网只读探测 | 2026-11-03 14:23～14:25 CST：`https://riverandraise.app` HTTP 200；`https://api.riverandraise.app/health` HTTP 200，`{"status":"ok"}`；未返回构建 SHA，因此不能确认候选部署 |
| 额外路径探测 | `GET /ready` HTTP 404；这是探索性请求，不作为规格要求或已确认 readiness 缺陷 |
| 本机真实链路条件 | 未配置 `TEX_TEST_DATABASE_URL`，Docker daemon 未运行；本次未在本机运行数据库/E2E，使用已有 GitHub 工作流隔离 PostgreSQL 执行 RC |
| 现场参与者/时间 | A/B/C 第一轮，D 第二轮首次加入；实际参与及时间均待填 |

原工作区处于 TEX-58 分支且有未交接修改；本次使用从最新 main 创建的独立工作区，不改动这些内容。未部署或变更云配置。Linear 的 `get_agent_context` 返回工具不存在；任务卡、代码和仓库规格作为本轮依据。

## 已有与本轮自动化证据

| 证据 | 状态与边界 |
| --- | --- |
| 前置任务 | 2026-11-03 查询：TEX-35/46/47/49/55/62 均为 Done；状态本身不证明实机通过 |
| [当前基线 CI](https://github.com/fujiabao89/Texas-Holdem/actions/runs/40658969854) | `headSha=d675f726…`，2026-10-28，7 job success：quality、e2e、e2e-real、e2e-timeline、perf-smoke、workflow-lint、repository-hygiene。核验了 job 状态；未把 job success 推导为已审计全部原始产物 |
| [本轮固定 SHA 完整 RC](https://github.com/fujiabao89/Texas-Holdem/actions/runs/41589752410) | 20/20：timeline 18（Chromium 14 / Firefox 2 / WebKit 2）、split 1、原生 background 1；每项一次 passed，retry/skip/xfail/flaky=0，三份报告 runner errors=0。`gate.json` 的 SHA 为上述基线，dirty=false，passed=true，三场 exitCode=0/validReport=true |
| RC 产物与审计 | `timeline-rc-d675f726821c5f54c1afd97d37b6be1f2c9a8b3f`，artifact ID `13209898007`，digest `sha256:8fdc46cb7127103bf145f0287f569d3448613d6a2f8ba94ea0a745d6e6ca87e8`。CI 上传前审计和下载后独立 `audit.ts` 均通过，9 文件；保留 90 天，正式发布前需按既有受控档案流程保存 |
| [草稿 PR #88 首次 CI](https://github.com/fujiabao89/Texas-Holdem/actions/runs/41590142476) | 文档提交 `407776ae602c8a93993c91293c82c5fdc68071c9` 的七个常规 CI job 全通过；不是实机验收。PR Policy 首次因正文缺少固定行失败，补上 `Linear: TEX-56` 后新运行通过，历史失败保留 |
| TEX-30 / TEX-43 | 查询时均为 Backlog；容量/Soak、目标部署、真实告警、恢复/回滚和用户发布批准不由本记录替代 |
| 本次文档校验 | 原工作区已安装的 Prettier 对 6 份修改文档检查通过；Python 核验 157 个本地文件链接，无缺失；`git diff --check` 通过。未为文档改动新增业务测试 |

本轮命令：`git fetch origin`、`git log -1 origin/main`、`Get-FileHash pnpm-lock.yaml -Algorithm SHA256`、`gh run list --commit <完整基线 SHA>`、`gh run view 40658969854 --json jobs,url,headSha,conclusion`、`gh workflow run timeline.yml --ref main -f sha=<完整基线 SHA>`，以及对上述公网入口的只读 `Invoke-WebRequest`。没有对生产执行写入、负载测试或故障注入。

产物复核：`gh run download 41589752410 --name timeline-rc-d675f726821c5f54c1afd97d37b6be1f2c9a8b3f --dir tests/e2e/.artifacts-timeline`；使用原工作区已安装的 tsx 执行当前基线的 `tests/e2e/real/timeline/audit.ts`，结果 `Timeline artifact audit passed (9 files)`。另逐项核对三份 UTF-8 JSON 的测试结果/浏览器分布及总报告，不只读取 Actions 的绿色状态。下载内容保留在 gitignore 路径，未纳入提交。该基线后续只增加验收文档；实际部署候选一旦确定，仍需核实或重跑其受影响证据。

## 设备登记（未执行）

| 代号 | 设备/最低档核对 | OS / 浏览器准确版本 | CSS 视口/方向/缩放 | 网络与采样工具 | 结果 |
| --- | --- | --- | --- | --- | --- |
| D1 | Android 型号、CPU/RAM 待填，按 06 §9.1 核对 | 待填 | 待填 | Wi-Fi/蜂窝、工具待填 | NOT_RUN |
| D2 | iPhone 15 实机待提供 | 待填 | 待填 | Wi-Fi/蜂窝、工具待填 | NOT_RUN |
| D3 | Windows 桌面实机待提供 | Windows/Edge 待填 | 1366×768 / 1920×1080，实际值待填 | 待填 | NOT_RUN |

## 实机验收矩阵

表内 D1/D2/D3 均代表分别执行并留证。实测时每台单列结果，不能只填汇总 PASS。

| ID | 场景 | 设备 | 当前状态 | 所需证据 |
| --- | --- | --- | --- | --- |
| M01–M02 | 3 真人邀请码加入、选座、Ready、第一轮开局/公共状态与底牌隔离 | D1/D2/D3 | NOT_RUN | 现场参与、Room/T1、逐客户端公开状态 |
| M03 | Fold/Check/Call/Bet/Raise/All-in/Time Bank；快捷金额、Slider、±、精确输入 | D1/D2 | NOT_RUN | 每个实际合法分支、handId、金额与触控结果 |
| M04 | 单视口、横竖屏、软键盘、Safari Safe Area/工具栏 | D1/D2 | NOT_RUN | 无页面滚动、所有合法动作可达的截图/录像 |
| M05 | 刷新、短断网、Wi-Fi↔蜂窝、后台恢复，行动期/结算期 | D1/D2/D3 | NOT_RUN | 恢复前后 Seat/Stack/D/SB/BB/handId，旧动画不重播 |
| M06 | 普通摊牌/全下/主边池、赢家揭示顺序与无遮挡结算 | D1/D2/D3 | NOT_RUN | 对应已命中分支的脱敏录像和公开分配摘要 |
| M07 | 第一轮完赛、赛果刷新、原会话直接访问、无身份降级 | D1/D2/D3 | NOT_RUN | T1 权威结果及每个恢复入口 |
| M08–M09 | 返回同 Room、邀请码恢复、Ready 清空、第二轮新人及开局阻塞 | D1/D2/D3 | NOT_RUN | Room 不变、D 首次加入、未入座/未准备/离线提示 |
| M10–M11 | 第二轮完成、新 Tournament ID/初始筹码、旧赛果与历史隔离 | D1/D2/D3 | NOT_RUN | T1≠T2、初始配置、第二轮完赛及旧场查询 |
| S02 | 2 人座序/D/SB/BB，跨手、刷新与重连 | D1/D2/D3 | NOT_RUN | 正常/刷新/重连三态，Heads-up 关系 |
| S03 | 3 人座序/D/SB/BB，跨手、刷新与重连 | D1/D2/D3 | NOT_RUN | 正常/刷新/重连三态 |
| S06 | 6 人座序/D/SB/BB，跨手、刷新与重连 | D1/D2/D3 | NOT_RUN | 标注辅助身份；三态对照 |
| S10 | 10 人座序/D/SB/BB，跨手、刷新与重连 | D1/D2/D3 | NOT_RUN | 标注辅助身份；三态对照 |
| UX | 音频解锁/恢复、Reduced Motion、触控/键盘焦点 | D1/D2/D3 | NOT_RUN | 工具、设置、操作记录 |
| PERF | 低端实机十人桌/摊牌输入延迟、帧率、长任务、动画降级和内存 | D1 | NOT_RUN | 原机采样区间/样本数/计算口径/摘要，门槛引用 06 §10.1 |

## 媒体、诊断与缺陷台账

| 索引 | 当前内容 |
| --- | --- |
| 实机截图/录像 | 未采集；待填受控位置、文件 SHA-256、场景/设备/时间范围、脱敏复核人 |
| 客户端与服务端诊断 | 未采集目标部署诊断；只接受字段白名单和必要序列/时钟元数据，不能导出原始 Token/底牌/事件/连接串 |
| 性能摘要 | 未采集；不把 CI 桌面模拟当作实机结果 |
| P0/P1/P2 产品缺陷 | 本轮尚未开展真人实测，不能声称“无缺陷”；发现后检索并关联唯一 Linear 任务 |
| 必测缺口 | 所有 NOT_RUN、未知部署 SHA 和缺现场证据均保留为验收缺口，不虚构产品缺陷 |

## 完成与交接

必须补齐同候选的实际环境身份、完整 RC 及审计、全部设备/场景、两轮完整旅程和第二轮新人、性能与诊断证据；无未处置 P0/P1，P2 有唯一任务与处置；再把本记录和受控媒体索引关联 [TEX-30](https://linear.app/texas-holdem/issue/TEX-30) / [TEX-43](https://linear.app/texas-holdem/issue/TEX-43)。候选或部署配置变化后重跑受影响证据。当前不批准发布，不把准备工作算作 TEX-56 完成。

文档同步：新增实机运行手册和本记录；同步 E2E、项目、工程、文档总索引。01～06 权威规格、安全/运维说明和应用目录 README：**已检查，无需更新**，原因是本轮仅落实既有验收要求，未改变接口、协议、产品行为、运行/部署方式或安全策略。未处理 PR 原始审查意见，无“已修正”回复；未触发 DeepSeek Harness 或 Greptile。
