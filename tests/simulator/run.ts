import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTestSeed, formatSeedReport } from "../support/seed";
import { deriveSeed } from "../support/random";

/**
 * Headless Simulator 入口（TEX-12）。
 *
 * 用法：`pnpm test:sim -- --seed <n>`（或环境变量 TEX_TEST_SEED）。
 *
 * TEX-12 只交付可复现入口与 Seed 派生地基；牌局长跑主循环、不变量断言与
 * Watchdog 由 TEX-16 在引擎落地后实现。当前引擎尚未创建，因此本入口
 * 校验参数后**受控跳过**（退出码 0、输出明确原因），不伪造任何牌局结果。
 */

async function main(): Promise<number> {
  const { seed, source } = resolveTestSeed();
  console.info(formatSeedReport(seed));
  console.info(`[tex-sim] seed 来源：${source}`);

  const engineEntry = new URL("../../packages/poker-engine/src/index.ts", import.meta.url);

  // 受控跳过只适用于「引擎入口确实不存在」（引擎尚未实现）；
  // 入口存在但加载/初始化失败（语法错误、初始化异常、依赖缺失）是真实故障，
  // 必须以非零退出码使 CI 失败，不得伪装成 SKIPPED。
  if (!existsSync(fileURLToPath(engineEntry))) {
    console.info(
      "[tex-sim] SKIP：packages/poker-engine 尚未实现（TEX-13 起）；本次运行未执行任何牌局，" +
        "不伪造模拟结果。引擎落地后由 TEX-16 接入长跑主循环。",
    );
    console.info("[tex-sim] RESULT: SKIPPED (engine-not-available)");
    return 0;
  }

  try {
    await import(engineEntry.href);
  } catch (error) {
    console.error("[tex-sim] 引擎入口存在但加载失败（真实故障，非受控跳过）：", error);
    console.error("[tex-sim] RESULT: FAILED (engine-load-error)");
    return 1;
  }

  // 引擎已存在时同样不在 TEX-12 执行长跑：主循环属于 TEX-16。
  console.info(
    "[tex-sim] SKIP：模拟主循环由 TEX-16 实现（docs/06-testing-strategy.md §5）；" +
      `首局派生 seed 预览：hand-1=${deriveSeed(seed, "hand-1")}`,
  );
  console.info("[tex-sim] RESULT: SKIPPED (simulator-loop-pending-tex-16)");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[tex-sim] 启动失败：", error);
    process.exit(1);
  },
);
