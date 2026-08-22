# E2E fixtures

E2E 共享 fixture 与 helper（非测试文件，不被 Playwright 自动收集）：

- [observability.ts](./observability.ts) — 自动收集浏览器 console error / pageerror / 网络 / WS 摘要，仅测试失败时输出 `[TEX-E2E-DIAGNOSTICS]`；URL 剥离 query/hash，不采集 headers/body（脱敏约束见 [tests/e2e/README.md](../README.md)）。
- [a11y.ts](./a11y.ts) — `@axe-core/playwright` 封装：按 impact 阈值扫描（默认 critical）。

用法：`import { expect, test } from "./fixtures/observability"`（diagnostics fixture 为 `auto`，无需显式请求）。
