import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 测试入口自测（TEX-12）：
 * 证明各测试层命令/配置真实存在且层间归属互斥，
 * 防止入口被误删或同一测试文件被两层重复执行。
 * 命令本身的可运行性由验证记录与 CI 覆盖。
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface ProjectConfig {
  test?: {
    name?: unknown;
    include?: unknown;
  };
}

describe("分层测试入口", () => {
  const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const requiredScripts = [
    "test",
    "test:unit",
    "test:rules",
    "test:integration",
    "test:ws",
    "test:e2e",
    "test:e2e:real",
    "test:sim",
    "test:perf",
  ];

  it.each(requiredScripts)("根 package.json 定义了 %s", (script) => {
    expect(rootPackage.scripts?.[script], `缺少脚本 ${script}`).toBeTruthy();
  });

  it("分层脚本指向互斥的运行器：vitest 层、Playwright e2e、独立 CLI sim/perf", () => {
    expect(rootPackage.scripts?.["test:unit"]).toContain("vitest run --project unit");
    expect(rootPackage.scripts?.["test:e2e"]).toContain("playwright test");
    expect(rootPackage.scripts?.["test:sim"]).toContain("tests/simulator/run.ts");
    expect(rootPackage.scripts?.["test:perf"]).toContain("tests/performance/run.ts");
  });

  it("vitest 配置恰好定义 unit/rules/integration/ws 四层", async () => {
    const configModule = (await import(resolve(repoRoot, "vitest.config.ts"))) as {
      default?: { test?: { projects?: ProjectConfig[] } };
    };
    const projects = configModule.default?.test?.projects;
    expect(projects).toBeDefined();
    const names = projects?.map((project) => project.test?.name);
    expect(names).toEqual(["unit", "rules", "integration", "ws"]);
  });

  it("各层 include 模式互斥：同一测试文件不会被两层重复执行", async () => {
    const configModule = (await import(resolve(repoRoot, "vitest.config.ts"))) as {
      default?: { test?: { projects?: ProjectConfig[] } };
    };
    const projects = configModule.default?.test?.projects ?? [];
    const allPatterns: string[] = [];
    for (const project of projects) {
      const include = project.test?.include;
      expect(
        Array.isArray(include) && include.length > 0,
        `层 ${project.test?.name} 无 include`,
      ).toBe(true);
      allPatterns.push(...(include as string[]));
    }
    expect(new Set(allPatterns).size).toBe(allPatterns.length);
  });

  it("E2E 与 Simulator 入口文件存在", () => {
    expect(existsSync(resolve(repoRoot, "tests/e2e/playwright.config.ts"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "tests/e2e/playwright.real.config.ts"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "tests/simulator/run.ts"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "tests/performance/run.ts"))).toBe(true);
  });

  it("真实链路 E2E 配置禁用重试且限定独立目录（文本断言，避免导入副作用）", () => {
    const source = readFileSync(resolve(repoRoot, "tests/e2e/playwright.real.config.ts"), "utf8");
    expect(source).toContain("retries: 0");
    expect(source).toContain('testDir: "./real"');
    expect(source).toContain('outputDir: ".artifacts-real"');
  });

  it("Playwright 门禁禁用重试：docs/06 §2.1 不得把重试后通过记为门禁通过", async () => {
    const configModule = (await import(resolve(repoRoot, "tests/e2e/playwright.config.ts"))) as {
      default?: { retries?: number };
    };
    expect(configModule.default?.retries).toBe(0);
  });
});
