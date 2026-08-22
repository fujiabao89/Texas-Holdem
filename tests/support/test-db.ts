import { describe } from "vitest";

/**
 * 测试数据库隔离工具/约定（TEX-12）。
 *
 * 原则（docs/06-testing-strategy.md §2.1）：
 * - 每次测试运行生成唯一 `runId`，使用独立 schema（`tex_test_<runId>`）等价隔离；
 * - 默认不连接任何真实数据库：未配置测试数据库 URL 时，`describeTestDatabase`
 *   以明确原因受控跳过，而不是失败或静默通过；
 * - 连接串不进入日志/错误信息；本模块只回显来源变量名。
 *
 * 使用方式见 tests/support/README.md；真实 PostgreSQL 连接由后续持久化任务接入。
 */

export const TEST_DATABASE_URL_ENV_VARS = ["TEX_TEST_DATABASE_URL", "DATABASE_URL"] as const;

export interface TestRunIdentity {
  readonly runId: string;
  readonly schemaName: string;
}

const RUN_ID_PATTERN = /^run_[0-9]{14}_[0-9a-z]{6,8}$/;

/** 生成唯一 runId：`run_<UTC时间戳14位>_<base36随机>`；now/random 可注入以便测试。 */
export function createTestRunId(
  now: () => number = () => Date.now(),
  random: () => number = () => Math.random(),
): string {
  const timestamp = new Date(now())
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `run_${timestamp}_${suffix}`;
}

/** 由 runId 推导隔离 schema 名（PostgreSQL 标识符 ≤63 字节，仅小写字母/数字/下划线）。 */
export function schemaNameForRun(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `schemaNameForRun: 非法 runId ${JSON.stringify(runId)}；应由 createTestRunId 生成`,
    );
  }
  const schemaName = `tex_test_${runId}`;
  // `run_` + 14 位 + `_` + ≤8 位 ⇒ 总长恒 ≤ 8 + 4 + 14 + 1 + 8 = 35，远低于 63。
  if (schemaName.length > 63) {
    throw new Error(`schemaNameForRun: schema 名超长（${schemaName.length} > 63）`);
  }
  return schemaName;
}

export interface TestDatabaseContext {
  /** 是否存在可用的测试数据库配置。 */
  readonly available: boolean;
  readonly runId: string;
  readonly schemaName: string;
  /** 连接串来源的环境变量名（不包含值本身）。 */
  readonly urlSource?: (typeof TEST_DATABASE_URL_ENV_VARS)[number];
  readonly skipReason?: string;
}

/** 解析测试数据库上下文；无配置时返回明确跳过原因，默认不连接任何真实数据库。 */
export function resolveTestDatabase(
  env: Record<string, string | undefined> = process.env,
): TestDatabaseContext {
  const runId = createTestRunId();
  const identity: TestRunIdentity = { runId, schemaName: schemaNameForRun(runId) };

  for (const variable of TEST_DATABASE_URL_ENV_VARS) {
    const value = env[variable];
    if (value !== undefined && value.trim() !== "") {
      return { available: true, ...identity, urlSource: variable };
    }
  }

  return {
    available: false,
    ...identity,
    skipReason:
      `未设置 ${TEST_DATABASE_URL_ENV_VARS.join(" 或 ")}；数据库集成测试受控跳过` +
      `（TEX-12 默认不连接任何真实数据库）`,
  };
}

/**
 * 数据库集成测试套件封装：配置缺失时整组受控跳过并输出原因；
 * 配置存在时向用例提供 runId/schemaName 等隔离标识。
 */
export function describeTestDatabase(
  suiteName: string,
  fn: (context: TestDatabaseContext) => void,
): void {
  const context = resolveTestDatabase();
  if (!context.available) {
    console.info(`[TEX-TEST-DB] SKIP ${suiteName}: ${context.skipReason}`);
  }
  describe.skipIf(!context.available)(suiteName, () => fn(context));
}
