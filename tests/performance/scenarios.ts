/**
 * 压测场景目标与门禁阈值（TEX-29）。
 *
 * 场景默认目标即权威规格 docs/06-testing-strategy.md §10.1 的「负载与持续时间」；
 * 门禁阈值（SLO）与 §10.1 Release 门槛一一对应。正式场景（releaseGate=true）的
 * 产物必须绑定候选提交 SHA，且不承诺在普通 PR CI 判定——PR 只跑 smoke；Nightly
 * 跑 reconnect；Release Load/Soak 由 Release 入口在隔离环境执行（见 performance
 * CI 工作流与 tests/performance/README.md）。smoke 只验证真实链路（功能不变量），
 * 不判 SLO，允许在 PR/本地以短时长运行。
 */
import type { SloCheck } from "./gates";

export type ScenarioName = "smoke" | "normal" | "burst" | "reconnect" | "soak" | "headroom";

export type ScenarioKind = "sustained" | "burst" | "reconnect";

export interface PerformanceTarget {
  readonly kind: ScenarioKind;
  readonly description: string;
  readonly rooms: number;
  readonly players: number;
  readonly durationMs: number;
  /** burst/reconnect 的动作/重连批量：窗口内发起 opCount 次命令/重连。 */
  readonly opCount?: number;
  readonly opWindowMs?: number;
  /** 达到可判 SLO 的最低样本/房间要求（不足判 insufficient-sample，不算达标）。 */
  readonly minOpSamples?: number;
  readonly releaseGate: boolean;
  /** 门禁引用的 §10.1 行（用于产物自述与 README 交叉引用）。 */
  readonly specRef: string;
}

export const SCENARIO_TARGETS: Record<ScenarioName, PerformanceTarget> = {
  smoke: {
    kind: "sustained",
    description: "真实链路功能冒烟：建房→满座→连续打若干手牌，断言链路不变量而非 SLO",
    rooms: 2,
    players: 4,
    durationMs: 90_000,
    releaseGate: false,
    specRef: "tests/performance/README.md §smoke",
  },
  normal: {
    kind: "sustained",
    description: "正常牌局：单实例 100 Room × 10 WS，持续 30 分钟",
    rooms: 100,
    players: 10,
    durationMs: 30 * 60_000,
    releaseGate: true,
    specRef: "docs/06-testing-strategy.md §10.1 正常牌局",
  },
  burst: {
    kind: "burst",
    description: "突发行动：1 秒内 500 个命令分布到 ≥50 Room",
    rooms: 50,
    players: 10,
    durationMs: 60_000,
    opCount: 500,
    opWindowMs: 1_000,
    releaseGate: true,
    specRef: "docs/06-testing-strategy.md §10.1 突发行动",
  },
  reconnect: {
    kind: "reconnect",
    description: "重连风暴：1 分钟内 500 个连接重连",
    rooms: 50,
    players: 10,
    durationMs: 90_000,
    opCount: 500,
    opWindowMs: 60_000,
    minOpSamples: 500,
    releaseGate: true,
    specRef: "docs/06-testing-strategy.md §10.1 重连风暴",
  },
  soak: {
    kind: "sustained",
    description: "稳定性 Soak：50 Room × 10 WS，持续 4 小时",
    rooms: 50,
    players: 10,
    durationMs: 4 * 60 * 60_000,
    releaseGate: true,
    specRef: "docs/06-testing-strategy.md §10.1 稳定性 Soak",
  },
  headroom: {
    kind: "sustained",
    description: "容量余量：单实例 130 Room × 10 WS，持续 10 分钟",
    rooms: 130,
    players: 10,
    durationMs: 10 * 60_000,
    releaseGate: true,
    specRef: "docs/06-testing-strategy.md §10.1 容量余量",
  },
};

export class ScenarioPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioPlanError";
  }
}

/** 解析后的实际运行计划（默认目标叠加 CLI 覆盖，且不高于全局上限）。 */
export interface ScenarioPlan {
  readonly name: ScenarioName;
  readonly target: PerformanceTarget;
  readonly rooms: number;
  readonly players: number;
  readonly durationMs: number;
  /** 相对官方目标是否为缩减运行（默认值被覆盖或低于目标）。 */
  readonly reducedEvidence: boolean;
}

export const MAX_ROOMS = 200;
export const MAX_PLAYERS_PER_ROOM = 10;
export const MIN_PLAYERS_PER_ROOM = 2;

export function isScenarioName(value: string): value is ScenarioName {
  return Object.prototype.hasOwnProperty.call(SCENARIO_TARGETS, value);
}

/**
 * 叠加 CLI 覆盖生成运行计划。覆盖允许上调也允许下调（本地 smoke/中等证据依赖下调），
 * 但不得越过硬边界（≥1 room、2–10 players、≥1s），下调时 reducedEvidence=true 以便
 * 产物如实标注「缩减运行、非 Release 结果」。
 */
export function resolvePlan(name: string, overrides: {
  readonly rooms?: number;
  readonly players?: number;
  readonly durationMs?: number;
}): ScenarioPlan {
  if (!isScenarioName(name)) {
    throw new ScenarioPlanError(`未知场景 ${JSON.stringify(name)}；可选：${Object.keys(SCENARIO_TARGETS).join("/")}`);
  }
  const target = SCENARIO_TARGETS[name];
  const rooms = overrides.rooms ?? target.rooms;
  const players = overrides.players ?? target.players;
  const durationMs = overrides.durationMs ?? target.durationMs;
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS) {
    throw new ScenarioPlanError(`场景 ${name}：rooms 须为 1–${MAX_ROOMS}，收到 ${rooms}`);
  }
  if (!Number.isInteger(players) || players < MIN_PLAYERS_PER_ROOM || players > MAX_PLAYERS_PER_ROOM) {
    throw new ScenarioPlanError(
      `场景 ${name}：players 须为 ${MIN_PLAYERS_PER_ROOM}–${MAX_PLAYERS_PER_ROOM}，收到 ${players}`,
    );
  }
  if (!Number.isInteger(durationMs) || durationMs < 1_000) {
    throw new ScenarioPlanError(`场景 ${name}：durationMs 须为正整数且 ≥1000，收到 ${durationMs}`);
  }
  const reducedEvidence =
    rooms < target.rooms || players < target.players || durationMs < target.durationMs;
  return { name, target, rooms, players, durationMs, reducedEvidence };
}

/** 门禁阈值（docs/06 §10.1 Release 门槛）。smoke 无 SLO（返回空表）。 */
const actionLatency = { p95: 250, p99: 500 }; // ms（docs/06 §10.1 正常牌局）
const reconnectLatency = { p95: 1_000, p99: 2_000 }; // ms（重连风暴）

export const SCENARIO_SLO: Record<ScenarioName, readonly SloCheck[]> = {
  smoke: [],
  normal: [
    { id: "action-p95", description: "Action→Event p95 ≤250 ms", threshold: actionLatency.p95, minSamples: 100, measure: { kind: "latency", series: "action", q: 0.95 } },
    { id: "action-p99", description: "Action→Event p99 ≤500 ms", threshold: actionLatency.p99, minSamples: 100, measure: { kind: "latency", series: "action", q: 0.99 } },
    { id: "business-5xx", description: "业务 5xx <0.1%", threshold: 0.001, minSamples: 100, measure: { kind: "rate", numerator: "http5xx", denominator: "httpRequests" } },
    { id: "unexpected-disconnect", description: "意外断连 <0.1%", threshold: 0.001, minSamples: 100, measure: { kind: "rate", numerator: "unexpectedDisconnect", denominator: "wsConnections" } },
    { id: "invariant-zero", description: "Invariant violation = 0", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "invariantViolations" } },
  ],
  burst: [
    { id: "action-p99", description: "突发 Action→Event p99 ≤1 s", threshold: 1_000, minSamples: 100, measure: { kind: "latency", series: "action", q: 0.99 } },
    { id: "burst-invariant-zero", description: "同桌 sequence/幂等/投影断言全部通过", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "sequenceViolations" } },
    { id: "burst-schema-zero", description: "schema 违反（投影/序列化回归）为 0", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "invariantViolations" } },
    { id: "burst-no-crash", description: "不崩溃（本地拉起时探活）", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "processCrash" } },
  ],
  reconnect: [
    { id: "reconnect-p95", description: "认证至首个完整 Snapshot p95 ≤1 s", threshold: reconnectLatency.p95, minSamples: 500, measure: { kind: "latency", series: "reconnect", q: 0.95 } },
    { id: "reconnect-p99", description: "认证至首个完整 Snapshot p99 ≤2 s", threshold: reconnectLatency.p99, minSamples: 500, measure: { kind: "latency", series: "reconnect", q: 0.99 } },
    { id: "recovery-error", description: "恢复错误率 <0.1%", threshold: 0.001, minSamples: 100, measure: { kind: "rate", numerator: "recoveryFailures", denominator: "recoveryAttempts" } },
  ],
  soak: [
    { id: "invariant-zero", description: "死锁/崩溃/Invariant violation = 0", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "invariantViolations" } },
    { id: "no-crash", description: "不崩溃（本地拉起时探活）", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "processCrash" } },
    { id: "memory-growth", description: "末小时内存均值 ≤ 稳态小时 1.1 倍", threshold: 1.1, minSamples: 0, measure: { kind: "memory-ratio" } },
  ],
  headroom: [
    { id: "invariant-zero", description: "不崩溃/不 OOM/Invariant violation = 0/无跨桌污染", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "invariantViolations" } },
    { id: "no-crash", description: "不崩溃（本地拉起时探活）", threshold: 0, minSamples: 0, measure: { kind: "zero", counter: "processCrash" } },
  ],
};
