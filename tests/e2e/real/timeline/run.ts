import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { validGateReport } from "../../../support/timeline-evidence";

// Each scenario starts fresh processes and a unique schema. RC keeps running the other
// scenarios after a failure to collect their evidence, then returns failure for the whole gate.
async function main() {
  const tier = process.argv[2] ?? "pr";
  if (!["pr", "rc"].includes(tier)) throw new Error("timeline tier must be pr or rc");
  const root = resolve(__dirname, "../../../..");
  const scenarios = tier === "rc" ? ["timeline", "split", "background"] : ["timeline"];
  let failed = false;
  const results: {
    scenario: string;
    exitCode: number;
    expectedCount: number;
    validReport: boolean;
  }[] = [];
  for (const scenario of scenarios) {
    rmSync(resolve(root, `tests/e2e/.artifacts-timeline/${scenario}/results.json`), {
      force: true,
    });
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "-c",
          "tests/e2e/playwright.timeline.config.ts",
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: {
            ...process.env,
            TEX_TIMELINE_TIER: tier,
            TEX_TIMELINE_SCENARIO: scenario,
            TEX_TIMELINE_HEADED: scenario === "background" ? "1" : "0",
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => done(code ?? 1));
      const interrupt = () => child.kill("SIGTERM");
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      child.once("exit", () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      });
    });
    const expectedCount = scenario === "timeline" ? (tier === "pr" ? 9 : 18) : 1;
    let validReport = false;
    try {
      const report = JSON.parse(
        readFileSync(
          resolve(root, `tests/e2e/.artifacts-timeline/${scenario}/results.json`),
          "utf8",
        ),
      );
      validReport = validGateReport(
        report,
        scenario === "timeline"
          ? { chromium: tier === "pr" ? 5 : 14, firefox: 2, webkit: 2 }
          : { chromium: 1 },
      );
    } catch {
      /* Missing reports are never success. */
    }
    results.push({ scenario, exitCode: code, expectedCount, validReport });
    failed ||= code !== 0 || !validReport;
  }
  mkdirSync(resolve(root, "tests/e2e/.artifacts-timeline"), { recursive: true });
  writeFileSync(
    resolve(root, "tests/e2e/.artifacts-timeline/gate.json"),
    JSON.stringify(
      {
        tier,
        sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        worktreeDirty:
          execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
            .length > 0,
        passed: !failed,
        results,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed ? 1 : 0;
}
void main().catch(() => {
  console.error("timeline runner failed");
  process.exitCode = 1;
});
