/**
 * Simulator CLI 参数解析（TEX-16）。
 *
 * 从 run.ts 抽出以便单测（run.ts 是可执行入口，import 即运行 main）。
 * 解析规则：`--games <n>` / `--tier smoke|nightly|rc` / `--sha <hex>` /
 * `--ledger <path>` / `--out <dir>` / `--seed <n>`（seed 值由 support/seed 解析，
 * 此处只跳过）；裸 `--` 分隔符被忽略——pnpm 在 Linux CI 上会把
 * `pnpm run script -- --flag` 的 `--` 透传给脚本（Windows 不透传），
 * 忽略它保证跨平台行为一致。未知参数显式抛错（退出码 2）。
 */
import type { SimulatorTier } from "./tiers";

export interface CliArgs {
  games?: number;
  tier?: SimulatorTier;
  sha?: string;
  ledger?: string;
  out: string;
}

export const USAGE = `用法：
  pnpm test:sim -- --seed <n> [--games <n>]
  pnpm test:sim -- --tier smoke|nightly --sha <hex> [--games <n>] [--ledger <file>]
  pnpm test:sim -- --tier rc --sha <hex> --ledger <file> [--games <n>]
选项：--out <dir> 产物目录（默认 tests/simulator/.artifacts）`;

export function parseArgs(argv: readonly string[], defaultOut: string): CliArgs {
  const args: CliArgs = { out: defaultOut };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--") {
      // pnpm/Linux 会把 `pnpm run script -- --flag` 的 `--` 分隔符透传给脚本；
      // 忽略裸分隔符，保证跨平台 CLI 行为一致（CI 失败案例：未知参数 --）。
      continue;
    } else if (arg === "--games" || arg.startsWith("--games=")) {
      const raw = arg.includes("=") ? arg.slice("--games=".length) : next;
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`--games 需要正整数，收到 ${raw ?? "(缺失)"}`);
      }
      args.games = Number(raw);
      if (!arg.includes("=")) i++;
    } else if (arg === "--tier" || arg.startsWith("--tier=")) {
      const raw = arg.includes("=") ? arg.slice("--tier=".length) : next;
      if (raw !== "smoke" && raw !== "nightly" && raw !== "rc") {
        throw new Error(`--tier 只支持 smoke|nightly|rc，收到 ${raw ?? "(缺失)"}`);
      }
      args.tier = raw;
      if (!arg.includes("=")) i++;
    } else if (arg === "--sha" || arg.startsWith("--sha=")) {
      const raw = arg.includes("=") ? arg.slice("--sha=".length) : next;
      if (raw === undefined || !/^[0-9a-f]{7,40}$/i.test(raw)) {
        throw new Error(`--sha 需要 7–40 位十六进制提交 SHA，收到 ${raw ?? "(缺失)"}`);
      }
      args.sha = raw;
      if (!arg.includes("=")) i++;
    } else if (arg === "--ledger" || arg.startsWith("--ledger=")) {
      const raw = arg.includes("=") ? arg.slice("--ledger=".length) : next;
      if (raw === undefined || raw === "") {
        throw new Error("--ledger 需要文件路径");
      }
      args.ledger = raw;
      if (!arg.includes("=")) i++;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const raw = arg.includes("=") ? arg.slice("--out=".length) : next;
      if (raw === undefined || raw === "") {
        throw new Error("--out 需要目录路径");
      }
      args.out = raw;
      if (!arg.includes("=")) i++;
    } else if (arg === "--seed" || arg.startsWith("--seed=")) {
      if (!arg.includes("=")) i++; // 由 resolveTestSeed 解析
    } else {
      throw new Error(`未知参数 ${arg}\n${USAGE}`);
    }
  }
  return args;
}
