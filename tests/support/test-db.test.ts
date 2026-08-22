import { describe, expect, it } from "vitest";
import {
  createTestRunId,
  resolveTestDatabase,
  schemaNameForRun,
  TEST_DATABASE_URL_ENV_VARS,
} from "./test-db";

describe("createTestRunId", () => {
  it("格式为 run_<14位UTC时间>_<base36后缀>", () => {
    const fixedNow = () => Date.UTC(2026, 7, 21, 12, 34, 56);
    const runId = createTestRunId(fixedNow, () => 0);
    expect(runId).toBe("run_20260821123456_000000");
  });

  it("同一毫秒内不同随机量不冲突；不同毫秒不冲突", () => {
    const fixedNow = () => 1_000;
    const first = createTestRunId(fixedNow, () => 0.1);
    const second = createTestRunId(fixedNow, () => 0.2);
    expect(first).not.toBe(second);

    const another = createTestRunId(
      () => 2_000,
      () => 0.1,
    );
    expect(another).not.toBe(first);
  });

  it("真实默认参数连续生成不重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createTestRunId()));
    expect(ids.size).toBe(200);
  });
});

describe("schemaNameForRun", () => {
  it("生成合法 schema 名：小写/数字/下划线且 ≤63 字符", () => {
    const schemaName = schemaNameForRun("run_20260821123456_ab12cd");
    expect(schemaName).toBe("tex_test_run_20260821123456_ab12cd");
    expect(schemaName).toMatch(/^[a-z0-9_]+$/);
    expect(schemaName.length).toBeLessThanOrEqual(63);
  });

  it("两个不同 runId 得到不同 schema 名", () => {
    expect(schemaNameForRun("run_20260821123456_aaaa00")).not.toBe(
      schemaNameForRun("run_20260821123456_aaaa01"),
    );
  });

  it("非法 runId 抛出明确错误", () => {
    expect(() => schemaNameForRun("arbitrary-name")).toThrow(/非法 runId/);
    expect(() => schemaNameForRun("")).toThrow(/非法 runId/);
  });
});

describe("resolveTestDatabase", () => {
  it("未配置任何数据库 URL 时明确受控跳过且不暴露连接串", () => {
    const context = resolveTestDatabase({});
    expect(context.available).toBe(false);
    expect(context.skipReason).toContain("TEX_TEST_DATABASE_URL");
    expect(context.skipReason).toContain("受控跳过");
    expect(context.urlSource).toBeUndefined();
    expect(context.schemaName).toMatch(/^tex_test_run_/);
  });

  it("配置了测试数据库 URL 时可用并只回显来源变量名", () => {
    const context = resolveTestDatabase({
      TEX_TEST_DATABASE_URL: "postgresql://user:secret@localhost:5432/test",
    });
    expect(context.available).toBe(true);
    expect(context.urlSource).toBe("TEX_TEST_DATABASE_URL");
    // 上下文对象不携带连接串值本身。
    expect(JSON.stringify(context)).not.toContain("secret");
  });

  it("支持回退变量 DATABASE_URL", () => {
    const context = resolveTestDatabase({ DATABASE_URL: "postgresql://localhost/test" });
    expect(context.available).toBe(true);
    expect(context.urlSource).toBe("DATABASE_URL");
    expect(TEST_DATABASE_URL_ENV_VARS).toContain("DATABASE_URL");
  });
});
