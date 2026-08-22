/**
 * 测试 Seed 机制（TEX-12）。
 *
 * 解析优先级：命令行 `--seed <n>` > 环境变量 `TEX_TEST_SEED` > 固定默认值。
 * 同一 seed 必须产生完全一致的测试行为；失败输出必须包含 seed 以便复现。
 *
 * 本文件保持零框架依赖（可被 Vitest 之外的入口（如 tests/simulator CLI）复用）；
 * vitest 的失败输出钩子见 seed-report.ts。
 */

export const TEST_SEED_ENV_VAR = "TEX_TEST_SEED";

/** 固定默认 seed：保证未显式指定时本地与 CI 行为一致。 */
export const DEFAULT_TEST_SEED = 20260821;

export type SeedSource = "flag" | "env" | "default";

export interface SeedResolution {
  readonly seed: number;
  readonly source: SeedSource;
}

export class TestSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestSeedError";
  }
}

function parsePositiveInteger(raw: string, origin: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new TestSeedError(`无效的测试 seed（${origin}）：${raw}；必须是十进制非负整数`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new TestSeedError(`无效的测试 seed（${origin}）：${raw}；超出安全整数范围`);
  }
  return value;
}

/** 从 argv 中提取 `--seed 42` 或 `--seed=42`；未提供时返回 undefined。 */
export function seedFromArgv(argv: readonly string[]): number | undefined {
  const flagIndex = argv.findIndex((arg) => arg === "--seed");
  if (flagIndex >= 0) {
    const value = argv[flagIndex + 1];
    if (value === undefined) {
      throw new TestSeedError("--seed 缺少参数值：应为 `--seed 42` 或 `--seed=42`");
    }
    return parsePositiveInteger(value, "命令行 --seed");
  }
  const prefix = "--seed=";
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return parsePositiveInteger(inline.slice(prefix.length), "命令行 --seed=");
  }
  return undefined;
}

/**
 * 解析本次测试运行使用的 seed。
 *
 * @param options.argv 命令行参数，默认 `process.argv`
 * @param options.env  环境变量，默认 `process.env`
 */
export function resolveTestSeed(options?: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
}): SeedResolution {
  const argv = options?.argv ?? process.argv;
  const env = options?.env ?? process.env;

  const fromFlag = seedFromArgv(argv);
  if (fromFlag !== undefined) {
    return { seed: fromFlag, source: "flag" };
  }

  const fromEnv = env[TEST_SEED_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { seed: parsePositiveInteger(fromEnv, `环境变量 ${TEST_SEED_ENV_VAR}`), source: "env" };
  }

  return { seed: DEFAULT_TEST_SEED, source: "default" };
}

/** 人类可读的 seed 回显；失败输出必须包含它。 */
export function formatSeedReport(seed: number): string {
  return `[TEX-TEST-SEED] seed=${seed}；复现方式：--seed ${seed} 或 ${TEST_SEED_ENV_VAR}=${seed}`;
}
