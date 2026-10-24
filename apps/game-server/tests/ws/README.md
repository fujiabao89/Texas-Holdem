# WebSocket tests

多客户端一致性、Snapshot/Event、重连与幂等测试（Multiplayer/WS 层）。

入口：`pnpm test:ws`（根 vitest 配置的 `ws` project）。可编程 WS 测试客户端与故障注入代理由联机任务（TEX-18 起）按 docs/06-testing-strategy.md §6 落地；此前本层以 `passWithNoTests` 受控跳过——空层成功退出并明确输出未发现测试，不伪造业务测试。

TEX-48：`lobby-lifecycle.test.ts` 使用真实 HTTP/WS 与 Tournament 执行器、Fake Clock/种子 2801，覆盖 IN_GAME/FINISHED 原身份重连、邀请暂停、同码重开、新成员门禁、WS 重新准备与新比赛；不依赖浏览器或数据库，数据库结论由 integration 层负责。
