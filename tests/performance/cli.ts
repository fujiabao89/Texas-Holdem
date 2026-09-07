/**
 * 性能压测 CLI 参数解析（TEX-29）。
 *
 * 从 run.ts 抽出以便单测（run.ts 是可执行入口）。解析规则与 simulator CLI 一致：
 * 裸 `--` 分隔符被忽略（pnpm/Linux 透传兼容）；`--x=<v>` 与 `--x <v>` 均接受；
 * 未知参数显式抛错（退出码 2，由 run.ts 捕获）。负载参数越界由 ./scenarios 校验。
 */
import type { ScenarioName } from "./scenarios";

export interface PerfCliArgs {
  readonly scenario: ScenarioName;
  /** 绑定运行与产物的候选提交 SHA（正式场景必填；smoke 缺省取 GITHUB_SHA/TEX_PERF_SHA）。 */
  readonly sha?: string;
  readonly rooms?: number;
  readonly players?: number;
  readonly durationMs?: number;
  /** 接已经运行的隔离被测实例（跳过本地拉起/清理）；本地拉起时缺省。 */
  readonly baseUrl?: string;
  /** 本地拉起后保留进程与 schema（便于事后人工检查），默认清理。 */
  readonly keepServer: boolean;
  readonly out: string;
  /** 运行标注（追加到 summary.meta，用于区分同一场景多次运行）。 */
  readonly label?: string;
}

/** parsePerfArgs 内部使用的可变累积器（末尾一次组装成只读 PerfCliArgs）。 */
interface RawArgs {
  scenario?: ScenarioName;
  sha?: string;
  rooms?: number;
  players?: number;
  durationMs?: number;
  baseUrl?: string;
  keepServer: boolean;
  out: string;
  label?: string;
}

export const USAGE = `用法：
  pnpm test:perf -- --scenario <smoke|normal|burst|reconnect|soak|headroom> [--sha <hex>]
选项：
  --scenario <name>   必填；smoke=真实链路功能冒烟（验证链路，不判 SLO）；
                      normal/burst/reconnect/soak/headroom=正式负载场景（判 docs/06 §10.1 门禁）。
  --sha <hex>         绑定产物与门禁的候选提交（7–40 位十六进制）。
                      smoke 缺省取 TEX_PERF_SHA 或 GITHUB_SHA；正式场景必填。
  --rooms <n>         覆盖场景默认房间数（不得低于场景下限）。
  --players <n>       覆盖每房玩家数（2–10）。
  --duration-ms <n>   覆盖场景持续时间（不得低于场景下限）。
  --base-url <url>    接已运行的隔离被测实例（http(s)://host:port），跳过本地拉起/迁移/清理。
  --keep-server       本地拉起后不清理（进程与 schema 保留，便于人工检查；默认清理）。
  --out <dir>         产物目录（默认 tests/performance/.artifacts）。
  --label <text>      运行标注（写入 summary.meta.label）。`;

export function parsePerfArgs(argv: readonly string[]): PerfCliArgs {
  const raw: RawArgs = { keepServer: false, out: "tests/performance/.artifacts" };
  let scenarioSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--") continue;
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s) : [arg, undefined];
    switch (flag) {
      case "--scenario": {
        const value = inline !== undefined ? inline : next;
        if (scenarioSeen) throw new Error(`--scenario 只能指定一次`);
        if (value === undefined) throw new Error(`--scenario 需要值`);
        raw.scenario = value as ScenarioName;
        scenarioSeen = true;
        if (inline === undefined) i++;
        break;
      }
      case "--sha": {
        const value = inline !== undefined ? inline : next;
        if (value === undefined || !/^[0-9a-f]{7,40}$/i.test(value)) {
          throw new Error(`--sha 需要 7–40 位十六进制提交 SHA，收到 ${value ?? "(缺失)"}`);
        }
        raw.sha = value;
        if (inline === undefined) i++;
        break;
      }
      case "--rooms": {
        const value = inline !== undefined ? inline : next;
        raw.rooms = parsePositiveInt("--rooms", value);
        if (inline === undefined) i++;
        break;
      }
      case "--players": {
        const value = inline !== undefined ? inline : next;
        raw.players = parsePositiveInt("--players", value);
        if (inline === undefined) i++;
        break;
      }
      case "--duration-ms": {
        const value = inline !== undefined ? inline : next;
        raw.durationMs = parsePositiveInt("--duration-ms", value);
        if (inline === undefined) i++;
        break;
      }
      case "--base-url": {
        const value = inline !== undefined ? inline : next;
        if (value === undefined || !/^https?:\/\/.+/.test(value)) {
          throw new Error(`--base-url 需要 http(s)://host[:port] URL，收到 ${value ?? "(缺失)"}`);
        }
        raw.baseUrl = value;
        if (inline === undefined) i++;
        break;
      }
      case "--keep-server": {
        raw.keepServer = true;
        break;
      }
      case "--out": {
        const value = inline !== undefined ? inline : next;
        if (value === undefined) throw new Error(`--out 需要目录路径`);
        raw.out = value;
        if (inline === undefined) i++;
        break;
      }
      case "--label": {
        const value = inline !== undefined ? inline : next;
        if (value === undefined) throw new Error(`--label 需要文本`);
        raw.label = value;
        if (inline === undefined) i++;
        break;
      }
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  if (!scenarioSeen || raw.scenario === undefined) {
    throw new Error(`--scenario 必填；运行 ${"pnpm test:perf -- --scenario smoke"} 查看用法`);
  }
  return {
    scenario: raw.scenario,
    sha: raw.sha,
    rooms: raw.rooms,
    players: raw.players,
    durationMs: raw.durationMs,
    baseUrl: raw.baseUrl,
    keepServer: raw.keepServer,
    out: raw.out,
    label: raw.label,
  };
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} 需要正整数，收到 ${value ?? "(缺失)"}`);
  }
  return Number(value);
}
