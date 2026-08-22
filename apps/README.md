# Apps

可直接部署或运行的应用。应用只编排界面、传输、身份和基础设施适配，不承载可复用的扑克规则。

| 应用 | 职责 | 技术栈 |
| --- | --- | --- |
| [web](./web/README.md) | 玩家 Web 客户端 | Next.js 16 + React 19 + Tailwind CSS 4 |
| [game-server](./game-server/README.md) | 实时游戏服务运行时 | Node.js + Fastify + `@fastify/websocket` |
