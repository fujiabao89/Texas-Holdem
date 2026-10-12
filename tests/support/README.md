# Test support utilities

跨层复用的测试基础设施。随机源、Fake Clock 和 Fixture 使用纯 TypeScript 工厂；TEX-62 的网络代理使用真实 TCP、单调时间和定时器，每次测试自建并关闭实例，不共享可变状态。

## 模块

| 模块 | 职责 |
| --- | --- |
| [seed.ts](./seed.ts) | Seed 解析：`--seed <n>` > 环境变量 `TEX_TEST_SEED` > 固定默认 `20260821`；非法值抛明确错误。零框架依赖（Simulator CLI 直接复用） |
| [seed-report.ts](./seed-report.ts) | `reportSeedOnFailure(seed)`：在 `it` 内调用一次，失败时输出 seed 与复现方式（vitest `onTestFailed`） |
| [random.ts](./random.ts) | `createSeededRandom(seed)`（mulberry32 确定性 PRNG）与 `deriveSeed(base, label)`（FNV-1a 场景派生）；同一 seed 序列恒一致 |
| [fake-clock.ts](./fake-clock.ts) | 受控时钟：手动 `advance`、按到期顺序执行、`dispose()` 清空全部 timer 并可断言无遗留 |
| [fixtures.ts](./fixtures.ts) | `defineFixture`：不可变 Builder（`with()` 返回新实例）、运行时校验聚合报错（含字段路径）。**约定：`packages/protocol` 落地后，validate 应升级为协议 Schema 校验** |
| [test-db.ts](./test-db.ts) | 测试数据库隔离：唯一 `runId`、schema 命名 `tex_test_<runId>`（≤63 字节）、缺配置时受控跳过；连接串永不进入输出 |
| [network-proxy.ts](./network-proxy.ts) | 双向真实 TCP 字节代理：每方向 RTT/2、固定 seed 抖动、保持字节顺序、断连/恢复及停止上游读取；转发样本仅记录字节数和时间。`close()` 清理连接及定时器 |
| [timeline-evidence.ts](./timeline-evidence.ts) | 服务端诊断白名单投影、跨手 DOM/动画与时钟断言、门禁执行数量校验；不导出牌面或原始消息 |

## 用法示例

```ts
import { reportSeedOnFailure } from "../support/seed-report";
import { resolveTestSeed } from "../support/seed";
import { createSeededRandom } from "../support/random";
import { createFakeClock } from "../support/fake-clock";

it("示例", () => {
  const { seed } = resolveTestSeed(); // 可被 --seed / TEX_TEST_SEED 覆盖
  reportSeedOnFailure(seed);          // 失败时输出 seed
  const random = createSeededRandom(seed);
  const clock = createFakeClock({ now: 0 });
  // ... 断言
  expect(clock.pendingTimers()).toBe(0); // 防泄漏
});
```

## 边界

- 引擎内部的 `SeededRandomSource`（docs/01-engine-spec.md §15）由 TEX-13 在 `packages/poker-engine` 实现；本目录不定义引擎接口。
- Fixture 必须通过公开入口构造场景，禁止篡改被测模块私有状态（docs/06-testing-strategy.md §3.4）。
- 各文件自测（`*.test.ts`）归属 unit 层（根 `pnpm test:unit`）。
