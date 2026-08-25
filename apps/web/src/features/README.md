# Features

按业务能力划分的 UI、状态、交互和功能内组件。功能之间通过明确接口协作。

`poker-table/` 与 `betting/`（TEX-25）只从 `RoomClient` 的 `ProjectionStore` 读取 Room/Game/Clock 投影，并通过其既有 `WebSocketTransport` 提交命令；不得创建平行 DTO、连接或本地扑克裁决状态。
