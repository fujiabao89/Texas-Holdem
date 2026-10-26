# Web tests

Web 单元、组件和交互测试。跨应用流程测试放到根目录 `tests/e2e`。

入口：`pnpm test:unit`（根 vitest 配置的 `unit` project 收集 `tests/unit/` 与 `src/**/*.test.ts`）。组件测试所需的 DOM 环境（jsdom/happy-dom）由首个组件测试任务按需引入；工具与约定见 [tests/support](../../../tests/support/README.md)。

TEX-49 的纯状态测试位于 `src/features/lobby/lobby-view.test.ts` 与 `src/features/result/result-view.test.ts`；浏览器组件交互见根 `tests/e2e/next-round/`，真实多人第二轮见 `tests/e2e/real/multiplayer-journey.spec.ts`。不引入另一套 DOM 测试依赖。
