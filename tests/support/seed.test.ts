import { describe, expect, it } from "vitest";
import { reportSeedOnFailure } from "./seed-report";
import {
  DEFAULT_TEST_SEED,
  TEST_SEED_ENV_VAR,
  formatSeedReport,
  resolveTestSeed,
  seedFromArgv,
  TestSeedError,
} from "./seed";

describe("resolveTestSeed", () => {
  it("未指定时返回固定默认 seed", () => {
    const resolution = resolveTestSeed({ argv: [], env: {} });
    expect(resolution).toEqual({ seed: DEFAULT_TEST_SEED, source: "default" });
  });

  it("命令行 --seed 42 与 --seed=42 均可解析且优先级最高", () => {
    expect(resolveTestSeed({ argv: ["node", "run", "--seed", "42"], env: {} })).toEqual({
      seed: 42,
      source: "flag",
    });
    expect(resolveTestSeed({ argv: ["--seed=7"], env: { [TEST_SEED_ENV_VAR]: "99" } })).toEqual({
      seed: 7,
      source: "flag",
    });
  });

  it("环境变量次之，空白值回退默认", () => {
    expect(resolveTestSeed({ argv: [], env: { [TEST_SEED_ENV_VAR]: "12345" } })).toEqual({
      seed: 12345,
      source: "env",
    });
    expect(resolveTestSeed({ argv: [], env: { [TEST_SEED_ENV_VAR]: "  " } })).toEqual({
      seed: DEFAULT_TEST_SEED,
      source: "default",
    });
  });

  it("非法值抛出明确错误：非数字、负数、小数、越界、缺参", () => {
    expect(() => seedFromArgv(["--seed", "abc"])).toThrow(TestSeedError);
    expect(() => seedFromArgv(["--seed", "-1"])).toThrow(TestSeedError);
    expect(() => seedFromArgv(["--seed", "1.5"])).toThrow(TestSeedError);
    expect(() => seedFromArgv(["--seed"])).toThrow(/缺少参数值/);
    expect(() => resolveTestSeed({ argv: [], env: { [TEST_SEED_ENV_VAR]: "1e9" } })).toThrow(
      TestSeedError,
    );
  });

  it("同一输入恒产生同一 seed（可复现前提）", () => {
    const argv = ["--seed", "20260821"];
    expect(resolveTestSeed({ argv, env: {} })).toEqual(resolveTestSeed({ argv, env: {} }));
  });
});

describe("失败输出包含 seed", () => {
  it("formatSeedReport 包含 seed 值与两种复现方式", () => {
    const report = formatSeedReport(424242);
    expect(report).toContain("seed=424242");
    expect(report).toContain("--seed 424242");
    expect(report).toContain(`${TEST_SEED_ENV_VAR}=424242`);
  });

  it("reportSeedOnFailure 可在测试内注册失败钩子且不抛错", () => {
    expect(() => reportSeedOnFailure(1)).not.toThrow();
  });
});
