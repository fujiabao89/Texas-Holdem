/**
 * 真实链路 E2E 全局 teardown（TEX-28）。
 *
 * 只清理本次运行创建的资源：终止 game-server 的 PostgreSQL 连接（按
 * application_name 精确匹配），DROP 隔离 schema CASCADE，删除运行身份文件。
 * 不触碰其他 schema / 开发者数据（docs/06 §5）。
 */
import { createRequire } from "node:module";

import { resolve } from "node:path";

import { clearRunIdentity, readRunIdentity, resolveRealDatabaseUrl, REPO_ROOT } from "./support/run-identity";

// pg 是 game-server 的依赖（pnpm 严格 node_modules）；Playwright 转换模块的 require 解析基准不定，
// 用 createRequire(__filename) 锚定本文件真实路径。
const require = createRequire(__filename);
const { Pool } = require(resolve(REPO_ROOT, "apps/game-server/node_modules/pg")) as typeof import("pg");

async function main(): Promise<void> {
  const identity = readRunIdentity();
  const pool = new Pool({ connectionString: resolveRealDatabaseUrl(process.env), max: 1 });
  try {
    // 只终止本次运行自己的连接（application_name 由配置注入连接串）。
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
      [`tex_e2e_real_${identity.runId}`],
    );
    // webServer 与 teardown 的先后顺序不作假设：带重试 DROP，最多等待 10 秒。
    let dropped = false;
    for (let attempt = 0; attempt < 20 && !dropped; attempt += 1) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${identity.schemaName} CASCADE`);
        dropped = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!dropped) throw new Error(`无法清理本次运行的隔离 schema（重试 20 次仍被占用）`);
    console.log(`[e2e-real] schema "${identity.schemaName}" dropped`);
  } finally {
    await pool.end();
    clearRunIdentity();
  }
}

export default async function teardown(): Promise<void> {
  await main().catch((error: unknown) => {
    console.error(`[e2e-real] teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}