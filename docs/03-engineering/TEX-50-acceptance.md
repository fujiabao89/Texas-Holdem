# TEX-50 规划与文档校准验收记录

> Linear：[TEX-50 校准项目现状与后续改进路线图](https://linear.app/texas-holdem/issue/TEX-50)
>
> 分支：`docs/TEX-50-align-project-status-and-follow-up-roadmap`
>
> 基线：`origin/main` `ebdbce16`
>
> 更新：2026-09-12

## 1. 交付范围

本任务只更新规划系统与文档，不改动应用、协议、数据库或测试代码：

- 新建 TEX-51～TEX-56，分别跟踪 Room/身份恢复、终局运行时卸载、盲注权威投影、赛果读取接口、赛果页刷新/直达和真实多人移动设备验收。
- 校准 TEX-34、TEX-37、TEX-44、TEX-45、TEX-47 的标题、项目归属、状态、标签、验收条件或依赖。
- 将 Linear 项目从 Backlog 校准为进行中，并建立“P0 稳定性与恢复闭环”“P0 复玩体验闭环”“P0 发布与实机验收”三个里程碑。
- 更新仓库入口、项目任务总览和文档总索引，建立一份当前能力、证据边界、问题到任务映射和建议顺序的稳定入口。

## 2. Linear 变更

| 类型 | 任务 |
| --- | --- |
| 恢复与生命周期 | [TEX-51](https://linear.app/texas-holdem/issue/TEX-51)、[TEX-52](https://linear.app/texas-holdem/issue/TEX-52) |
| 协议与赛果数据 | [TEX-53](https://linear.app/texas-holdem/issue/TEX-53)、[TEX-54](https://linear.app/texas-holdem/issue/TEX-54) |
| 前端赛果恢复 | [TEX-55](https://linear.app/texas-holdem/issue/TEX-55) |
| 真实设备验收 | [TEX-56](https://linear.app/texas-holdem/issue/TEX-56) |

依赖已登记为 TEX-53 → TEX-47、TEX-54 → TEX-55、TEX-48 → TEX-49；TEX-56 等待 TEX-35、TEX-46、TEX-47、TEX-49 与 TEX-55。标签按职责使用“前端”“后端”，跨端验收同时标记两者。

## 3. 文档一致性检查

- 根 README 不再把仓库描述为空工程，明确当前 main 基线和未合并视觉任务边界。
- `docs/README.md` 的 01～06 状态表改为当前实现事实，并链接新的路线图。
- `docs/00-project/` 保留 TEX-11～TEX-43 稳定任务卡，同时以新路线图承接 TEX-34～TEX-56 的实时后续闭环。
- 交付门槛与根 `AGENTS.md` 对齐：DeepSeek Harness 只由用户手动启动，不作为提交或推送门禁。
- 已检查应用目录 README、01～06 权威规格、运维与安全说明；本任务没有改变产品行为、公开接口、数据结构、部署方式或安全边界，因此无需修改这些正文规格。

## 4. 验证

文档提交前执行：

```text
git diff --check
pnpm exec prettier --check <本任务修改的 Markdown 文件>
PowerShell 相对 Markdown 链接存在性检查
```

本任务为文档与 Linear 元数据变更，不运行应用测试；既有 697 项单元测试、43 项选定规则/集成/WebSocket 测试与 Simulator 数字只是审阅输入，不能当成本提交重新执行的验证。

## 5. 未覆盖边界

- 未创建 Pull Request；是否创建和合并由用户后续决定。
- 未执行 TEX-51～TEX-56 的工程实现，也未把评审中的 TEX-44/TEX-45 视作 main 已交付。
- 未自行启动 DeepSeek Harness 或 Greptile 审查。
