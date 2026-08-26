# Features

按业务能力划分的 UI、状态、交互和功能内组件。功能之间通过明确接口协作。

`poker-table/` 与 `betting/`（TEX-25）只从 `RoomClient` 的 `ProjectionStore` 读取 Room/Game/Clock 投影，并通过其既有 `WebSocketTransport` 提交命令；不得创建平行 DTO、连接或本地扑克裁决状态。

`result/`、`settings/` 与 `hand-history/`（TEX-27）同样只读取 `ProjectionStore` 投影和既有 HTTP 端点：赛果排名来自服务端快照，"再来一局"仅经 `startTournament` 权威流程，Hand History 只消费服务端投影的列表/详情与本手已应用事件，永不渲染他人未公开底牌。
