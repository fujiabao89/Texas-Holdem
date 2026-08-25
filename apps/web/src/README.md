# Web source

Web 应用源码根目录。按路由入口、功能模块与跨功能基础能力组织。

TEX-23/TEX-24 的跨功能基础能力位于 `protocol/`、`state/`、`messages/` 与 `features/lobby/`：网络输入先由 `@texas-holdem/protocol` Schema 校验，房间/牌局镜像只能由 Snapshot 或连续 Event Patch 改写。纯 UI 状态使用 Jotai，不能改写 Server 投影。
