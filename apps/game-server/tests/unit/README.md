# Unit tests

隔离测试服务端模块、投影和协议适配。

入口：`pnpm test:unit`（根 vitest 配置的 `unit` project 收集本目录与 `src/**/*.test.ts`）。时序类用例使用 [tests/support](../../../tests/support/README.md) 的 Fake Clock，随机数据使用可复现 seed。
