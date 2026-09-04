/**
 * TEX-28 真实链路 E2E 的运行身份（runId / 隔离 schema / 端口）。
 *
 * Playwright 配置（主进程）在每次运行时生成唯一 runId 并写入
 * `.run-identity.json`；global teardown 与测试 worker（独立进程）经该文件
 * 读取同一身份，保证「启动器建 schema → 测试使用 → teardown 清理」三方一致。
 * 文件只含 runId/schema/端口，不含数据库连接串等敏感值。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export interface RealRunIdentity {
  readonly runId: string;
  readonly schemaName: string;
  readonly serverPort: number;
  readonly webPort: number;
}

const here = __dirname;
export const IDENTITY_FILE = resolve(here, "../.run-identity.json");

/** 仓库根目录（tests/e2e/real/support 上溯 4 级）；供依赖解析锚定绝对路径。 */
export const REPO_ROOT = resolve(here, "../../../..");

const SCHEMA_PREFIX = "tex_e2e_real_";
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function createRealRunId(now = Date.now()): string {
  const timestamp = new Date(now).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${timestamp}${suffix}`;
}

export function schemaNameForRunId(runId: string): string {
  const schemaName = `${SCHEMA_PREFIX}${runId}`;
  if (!SCHEMA_NAME_PATTERN.test(schemaName) || schemaName.length > 63) {
    throw new Error(`schemaNameForRunId: 非法 runId（生成 schema 名超限）`);
  }
  return schemaName;
}

export function writeRunIdentity(identity: RealRunIdentity): void {
  // Playwright worker 进程会为 project 配置重新加载 config 模块，顶层调用会再次
  // 执行——必须幂等：仅主进程（首次加载）写入，worker 一律沿用现有文件，否则
  // worker 生成的新 runId 会覆盖 schema 名，导致测试按不存在的 schema 查询。
  if (existsSync(IDENTITY_FILE)) return;
  writeFileSync(IDENTITY_FILE, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export function readRunIdentity(): RealRunIdentity {
  if (!existsSync(IDENTITY_FILE)) {
    throw new Error(`未找到运行身份文件 ${IDENTITY_FILE}；真实链路 E2E 必须经 playwright.real.config.ts 启动`);
  }
  return JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as RealRunIdentity;
}

export function clearRunIdentity(): void {
  if (existsSync(IDENTITY_FILE)) unlinkSync(IDENTITY_FILE);
}

/**
 * 解析真实 PostgreSQL 连接串（来源与 Integration 层一致：TEX_TEST_DATABASE_URL
 * 或 DATABASE_URL）。缺配置时抛出带指引的错误——真实链路 E2E 不允许静默降级。
 */
export function resolveRealDatabaseUrl(env: Record<string, string | undefined>): string {
  for (const name of ["TEX_TEST_DATABASE_URL", "DATABASE_URL"] as const) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw new Error(
    "真实链路 E2E 需要设置 TEX_TEST_DATABASE_URL 或 DATABASE_URL（PostgreSQL 连接串）；" +
      "例如本地：docker run 提供 127.0.0.1:55432 后 export TEX_TEST_DATABASE_URL=postgres://...",
  );
}

/** 为连接串附加 application_name，teardown 据此只终止本次运行自己的连接。 */
export function withApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}