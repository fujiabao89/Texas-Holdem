# Web application

玩家 Web 客户端（Next.js 16 + React 19 + Tailwind CSS 4）。采用单一 `src/app` 路由入口；页面组合功能模块，扑克规则以服务端投影和共享协议为准，客户端绝不裁决牌局。

TEX-24 已实现 Home、创建/加入表单、邀请码预填/复制和 Lobby 的选座、Ready、房主配置/踢人/开局反馈。TEX-21 在同一 Transport 上实现 WebSocket 认证、Room/Game 权威快照、断线重连、Token 恢复和有序投影消费；页面不根据命令回执模拟状态。TEX-25 已实现白色页面中的深青绿色椭圆响应式牌桌、服务端 `LegalActions` 驱动的下注/加注/All-in/Time Bank、命令 pending 与重连反馈。TEX-26 在同一投影/Transport 生命周期上增加 AnimationQueue、可访问的本地 Kenney CC0 音效开关和重连/接管体验：牌桌外左上角白色留白区的共享 Deck 不占用 Board 或玩家手牌空间，第一、二轮手牌从其实际 DOM 位置逐张飞向全部座位，两轮结束后本人的服务端投影双牌才依次翻开；公共牌在目标框内逐张入框、翻面，Showdown 仅按服务端 `bestFiveCards` 组合公开候选牌；本地音效预加载，同一页面以共享单通道抢占、后台牌桌停声，Snapshot/重连/Hard Forward 同步清除延迟 cue，过牌、跟注、下注、加注、All-in 与弃牌使用不同声音。动画只消费已连续应用的 Event，Snapshot/重连是清队列的展示屏障，操作、计时和命令仍只读 canonical projection。赛果页和历史仍由后续任务实现。

## 命令

```bash
pnpm --filter @texas-holdem/web dev        # 本地开发
pnpm --filter @texas-holdem/web build      # 生产构建
pnpm --filter @texas-holdem/web lint       # ESLint
pnpm --filter @texas-holdem/web typecheck  # tsc --noEmit
```

也可经根目录 `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` 由 Turbo 统一编排。

## 结构

- `src/app/` — App Router 路由壳与全局 Provider；没有 `pages` router。
- `src/protocol/` — 严格 Schema 边界的 HTTP/WS 客户端、当前 Tab Token 存储。
- `src/state/` — Server 投影镜像、重同步状态与纯 UI Jotai atoms。
- `src/messages/` — 唯一的 P0 中文用户文案与类型安全 key。
- `src/features/lobby/` — 创建、加入与 Lobby 的客户端流程；不维护平行 Room DTO。
- `src/features/poker-table/`、`src/features/betting/` — 只展示投影的牌桌/Seat/Board/Pot 与基于 `LegalActions` 的交互；不裁决牌局或推演筹码。

## 环境变量

见 [.env.example](./.env.example)。仅 `NEXT_PUBLIC_*` 前缀变量暴露到浏览器，只放非敏感公开配置；敏感值只由部署平台注入。HTTP API 和 WebSocket base URL 可以使用该公开配置；`playerToken` 绝不能写入 URL、环境变量或日志。
