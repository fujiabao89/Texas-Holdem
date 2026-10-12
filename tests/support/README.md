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

TEX-62 的 `websocket-text.ts` 对 Playwright 1.62 Firefox Juggler 观察器返回的 Latin-1 字节串执行严格 UTF-8 解码；Chromium/WebKit 原生文本不转换，异常编码明确失败。只修复被动测试观察，不修改应用消息。单测覆盖中文/Emoji/希腊字母、ASCII、Buffer 和非法字节。公开派奖证据只导出 handId、玩家 ID/测试昵称和金额，不导出牌面或原始 payload。

终局驾驶按完整批次边界计数：普通摊牌等待 GAME_SNAPSHOT/RECONNECT_RESULT 的终局状态；Fold-to-win 等待下一手 HAND_STARTED，最终手等待 TOURNAMENT_FINISHED。SHOWDOWN_STARTED Patch 的 HAND_END 和第一条 POT_AWARDED 都不能提前完成目标，确保多 Pot 分配已收齐。hand-boundary 单测覆盖该竞争；真实目标分支仍显式校验权威分配，恢复 Snapshot 不可掩盖缺失事件。

代理回归修正：每方向只由一个定时 FIFO 泵写出 TCP 块，计时到期后只从队头排空；遵守真实 write/drain 背压，resumeReads 不覆盖未解除的写压力。128 个真实分块、RTT 300ms/抖动 149ms/seed 62 的旧实现出现字节乱序，新实现完整保序。恢复到下一手 Snapshot 也可确认已收到派奖的上一手结束，分配分支仍独立校验。
