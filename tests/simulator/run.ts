/**
 * Headless Simulator CLI 入口（TEX-12 建立入口，TEX-16 接入长跑主循环）。
 *
 * 用法：
 *   pnpm test:sim -- --seed <n> [--games <n>]          单 seed 批次（默认 32 场；seed 即第 1 场）
 *   pnpm test:sim -- --tier smoke --sha <hex>          PR Smoke：已知失败 seed + SHA 派生 ≥200 场
 *   pnpm test:sim -- --tier nightly --sha <hex>        Nightly：SHA 派生 ≥10,000 场
 *   pnpm test:sim -- --tier rc --sha <hex> --ledger <file>   RC：累计 ≥50,000、fresh ≥10,000
 * 可选：--games <n>（覆盖档位场次下限）、--out <dir>（产物目录，默认 tests/simulator/.artifacts）。
 * SHA 也可经环境变量 TEX_SIM_SHA / GITHUB_SHA 提供。
 *
 * 全部随机性由 seed 驱动；失败时输出含 seed 的重放命令并将完整现场写入产物目录，
 * 成功运行只保存聚合统计（docs/06-testing-strategy.md §5）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSeedReport, resolveTestSeed } from "../support/seed";
import { deriveSeed } from "../support/random";
import { runTournament } from "./long-running-games/tournament-runner";
import { CoverageStats, TIER_REQUIRED_CATEGORIES } from "./long-running-games/stats";
import {
  SimulationFailure,
  formatFailureReport,
  writeFailureArtifact,
} from "./long-running-games/failure";
import { parseArgs, USAGE } from "./cli-args";
import type { CliArgs } from "./cli-args";
import { planNightlySeeds, planRcSeeds, planSmokeSeeds } from "./tiers";
import type { SimulatorTier, TierPlan } from "./tiers";

interface LedgerFile {
  readonly version: 1;
  readonly entries: readonly { readonly sha: string; readonly seeds: readonly number[] }[];
}

function loadLedger(path: string): LedgerFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`--ledger 文件格式非法：${path}`);
  }
  return parsed;
}

function appendLedger(ledger: LedgerFile, sha: string, seeds: readonly number[]): LedgerFile {
  const existing = ledger.entries.find((e) => e.sha === sha);
  const merged = existing
    ? { sha, seeds: [...new Set([...existing.seeds, ...seeds])] }
    : { sha, seeds: [...seeds] };
  return {
    version: 1,
    entries: [...ledger.entries.filter((e) => e.sha !== sha), merged],
  };
}

function resolveSha(args: CliArgs): string {
  const sha = args.sha ?? process.env.TEX_SIM_SHA ?? process.env.GITHUB_SHA;
  if (!sha) {
    throw new Error(`--tier 需要提交 SHA（--sha 或环境变量 TEX_SIM_SHA / GITHUB_SHA）\n${USAGE}`);
  }
  return sha;
}

function resolveTierPlan(args: CliArgs): { plan: TierPlan; sha: string; ledger: LedgerFile | null; ledgerPath: string | null } {
  const sha = resolveSha(args);
  if (args.tier === "smoke" || args.tier === "nightly") {
    // 台账可选：提供时同样记录已运行 seed（供后续 RC 判定 fresh）。
    const ledger = args.ledger ? loadLedger(args.ledger) : null;
    const plan =
      args.tier === "smoke" ? planSmokeSeeds(sha, args.games) : planNightlySeeds(sha, args.games);
    return { plan, sha, ledger, ledgerPath: args.ledger ?? null };
  }
  // rc：必须提供台账才能证明「≥10,000 个此前未运行 seed」。
  if (!args.ledger) {
    throw new Error(`--tier rc 需要 --ledger <file> 以跟踪已运行 seed（docs/06-testing-strategy.md §5）\n${USAGE}`);
  }
  const ledger = loadLedger(args.ledger);
  const ranForSha = new Set(ledger.entries.find((e) => e.sha === sha)?.seeds ?? []);
  const ranEver = new Set(ledger.entries.flatMap((e) => [...e.seeds]));
  return {
    plan: planRcSeeds(sha, {
      ranForSha,
      ranEver,
      ...(args.games !== undefined ? { totalTarget: args.games } : {}),
    }),
    sha,
    ledger,
    ledgerPath: args.ledger,
  };
}

/** 单 seed 批次：seed 本身作为第 1 场（失败重放 `--seed <n> --games 1` 即精确复现该场）。 */
function singleModeSeeds(masterSeed: number, games: number): number[] {
  return [
    masterSeed,
    ...Array.from({ length: games - 1 }, (_, i) => deriveSeed(masterSeed, `sim-${i + 1}`)),
  ];
}

function writeSummary(outDir: string, summary: Record<string, unknown>): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), ".artifacts"));
  const startedAt = performance.now();
  const stats = new CoverageStats();

  let seeds: number[];
  let modeLabel: string;
  let tier: SimulatorTier | null = null;
  let sha: string | null = null;
  let ledger: LedgerFile | null = null;
  let ledgerPath: string | null = null;

  if (args.tier) {
    const resolved = resolveTierPlan(args);
    tier = resolved.plan.tier;
    sha = resolved.sha;
    ledger = resolved.ledger;
    ledgerPath = resolved.ledgerPath;
    seeds = resolved.plan.seeds;
    modeLabel = `tier=${tier} sha=${sha}`;
    console.info(`[tex-sim] ${modeLabel}：${resolved.plan.description}`);
  } else {
    const { seed, source } = resolveTestSeed();
    const games = args.games ?? 32;
    seeds = singleModeSeeds(seed, games);
    modeLabel = `single seed=${seed}（来源 ${source}）games=${games}`;
    console.info(formatSeedReport(seed));
    console.info(`[tex-sim] ${modeLabel}`);
  }

  const progressStep = Math.max(1, Math.floor(seeds.length / 20));
  let completed = 0;
  let totalHands = 0;
  let totalActions = 0;

  for (const seed of seeds) {
    let result;
    try {
      result = runTournament(seed, { statsSummary: () => stats.summary() });
    } catch (error) {
      const failure =
        error instanceof SimulationFailure
          ? error
          : new SimulationFailure({
              category: "engine-error",
              message: error instanceof Error ? error.message : String(error),
              seed,
              scenario: null,
              stats: stats.summary(),
            });
      const artifact = writeFailureArtifact(args.out, failure);
      console.error(formatFailureReport(failure));
      console.error(`[tex-sim] 失败产物：${artifact}`);
      writeSummary(args.out, {
        mode: modeLabel,
        result: "FAILED",
        tier,
        gitSha: sha,
        category: failure.category,
        seed: failure.seed,
        replayCommand: failure.replayCommand(),
        completedGames: completed,
        statsSummary: stats.summary(),
      });
      return 1;
    }
    stats.recordTournament(result);
    completed++;
    totalHands += result.hands.length;
    totalActions += result.actionsTaken;
    if (tier !== null) {
      if (completed % progressStep === 0 || completed === seeds.length) {
        console.info(`[tex-sim] 进度 ${completed}/${seeds.length}`);
      }
    } else {
      console.info(
        `[tex-sim] seed=${result.seed} ${result.scenario.label} hands=${result.hands.length} actions=${result.actionsTaken} champion=${result.champion} ${result.elapsedMs.toFixed(1)}ms`,
      );
    }
  }

  const elapsedMs = performance.now() - startedAt;

  // 分层运行：覆盖类别某类为零 = 生成器覆盖失败（docs/06 §5）。
  if (tier !== null) {
    const missing = stats.missingCategories(TIER_REQUIRED_CATEGORIES);
    if (missing.length > 0) {
      const failure = new SimulationFailure({
        category: "coverage-gap",
        message: `分层运行存在零覆盖类别（生成器覆盖失败）`,
        seed: null,
        scenario: null,
        missingCategories: missing,
        stats: stats.summary(),
        ...(sha !== null ? { gitSha: sha } : {}),
      });
      const artifact = writeFailureArtifact(args.out, failure);
      console.error(formatFailureReport(failure));
      console.error(`[tex-sim] 失败产物：${artifact}`);
      writeSummary(args.out, {
        mode: modeLabel,
        result: "FAILED",
        tier,
        gitSha: sha,
        category: "coverage-gap",
        missingCategories: missing,
        completedGames: completed,
        statsSummary: stats.summary(),
      });
      return 1;
    }
  }

  // RC / 显式提供台账的运行：记录已运行 seed，供后续 RC 判定 fresh。
  if (ledgerPath !== null && ledger !== null) {
    const updated = appendLedger(ledger, sha!, seeds);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    console.info(`[tex-sim] 台账已更新：${ledgerPath}`);
  }

  const summary = {
    mode: modeLabel,
    result: "OK",
    // 分层运行报告的追溯字段（docs/06 §12.4：证据绑定同一候选提交）。
    tier,
    gitSha: sha,
    tournaments: completed,
    hands: totalHands,
    actions: totalActions,
    avgHandsPerTournament: Number((totalHands / Math.max(1, completed)).toFixed(2)),
    avgActionsPerTournament: Number((totalActions / Math.max(1, completed)).toFixed(2)),
    elapsedMs: Number(elapsedMs.toFixed(0)),
    seedRange: seeds.length > 0 ? { first: seeds[0], last: seeds[seeds.length - 1]!, count: seeds.length } : null,
    coverage: stats.summary(),
  };
  writeSummary(args.out, summary);
  console.info(
    `[tex-sim] 完成 ${completed} 场 / ${totalHands} 手 / ${totalActions} 动作，耗时 ${elapsedMs.toFixed(0)}ms`,
  );
  const summaryEntries = Object.entries(stats.summary());
  if (summaryEntries.length > 0) {
    console.info(`[tex-sim] 覆盖统计：${summaryEntries.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  console.info(`[tex-sim] 摘要：${join(args.out, "summary.json")}`);
  console.info("[tex-sim] RESULT: OK");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[tex-sim] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    console.error("[tex-sim] RESULT: FAILED (usage-or-load-error)");
    process.exit(2);
  },
);
