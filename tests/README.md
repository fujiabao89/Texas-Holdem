# Project-level tests

跨应用的端到端、模拟和性能验证。测试必须覆盖协议、断线恢复和关键扑克不变量。

当前（TEX-11）的测试入口为 `apps/game-server` 的 vitest 冒烟测试（根目录 `pnpm test` 经 Turbo 调用）。本目录的 e2e / 模拟 / 性能测试设施由 TEX-12（测试地基）起建设。
