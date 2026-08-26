# Web source

Web 应用源码根目录。按路由入口、功能模块与跨功能基础能力组织。

TEX-23/TEX-24/TEX-21 的跨功能基础能力位于 `protocol/`、`state/`、`messages/` 与 `features/lobby/`；TEX-25 的 `features/poker-table/` 与 `features/betting/` 只消费这些能力。网络输入先由 `@texas-holdem/protocol` Schema 校验，房间/牌局镜像只能由权威 Snapshot 或连续 Event Patch 改写。纯 UI 状态使用 Jotai，不能改写 Server 投影；`COMMAND_RESULT` 只管理 pending、反馈与同一序列化命令的重试，Clock 只管理展示态。
