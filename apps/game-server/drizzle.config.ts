import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit 配置（docs/03-data-model.md §5.9 / §13 决策 1）。
 *
 * - `generate`：从 `schema/` 生成版本化 SQL 迁移到 `migrations/`（提交前人工审查）。
 * - 生产执行迁移使用 `pnpm --filter @texas-holdem/game-server db:migrate`
 *   （drizzle-orm 官方 migrator + 显式 `search_path`，见 migrations/migrate.ts）；
 *   禁止对任何共享环境使用 `drizzle-kit push`。
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/persistence/schema",
  out: "./src/infrastructure/persistence/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
