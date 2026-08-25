/**
 * Tournament 运行时状态（docs/04-game-server-architecture.md §6）。
 *
 * 每桌 Tournament Runtime 封装 Engine 状态、wire sequence 与 Timer generation；
 * Tournament 串行执行器是该 Runtime 的唯一提交者（§7.1）。引擎是权威扑克状态，
 * 只能由执行器在队列内调用；其余模块只读 `getView()` 的不可变快照。
 *
 * `connected` 只用于断线宽限与无真人判定（TEX-20 内部），连接状态的权威投影在
 * RoomSnapshot（02 §9.2），二者用途分离、不会在投影中重复演进。
 */

import type { TournamentConfig } from "@texas-holdem/protocol";
import {
  TournamentEngine,
  initialTimeBankState,
  type LegalActions,
  type RandomSource,
  type TimeBankState,
  type TournamentEngineOptions,
  type TournamentState,
} from "@texas-holdem/poker-engine";
import type { IdSource } from "../rooms/id-source";
import type { TimerHandle, TimerScheduler } from "../scheduler/timer-scheduler";

export type TournamentStatus = "RUNNING" | "FINISHED" | "ABANDONED_NO_HUMAN" | "FROZEN";

export interface PlayerRuntimeRecord {
  readonly playerId: string;
  /** tournament_players.id（结果更新定位用；由开局快照分配）。 */
  readonly tournamentPlayerId: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly displayName: string;
  /** 宽限计时用途（非投影权威；权威连接状态在 RoomSnapshot）。 */
  connected: boolean;
  graceHandle: TimerHandle | null;
  graceGeneration: number;
  /** 服务器权威 Time Bank 余额（§8.4），不进入 Engine Action 联合类型。 */
  timeBank: TimeBankState;
}

/** 执行器独占的可变运行时持有者；对外只经 `runtimeView()` 暴露不可变快照。 */
export interface TournamentRuntimeState {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly config: TournamentConfig;
  readonly engine: TournamentEngine;
  readonly players: ReadonlyMap<string, PlayerRuntimeRecord>;
  readonly seatToPlayer: ReadonlyMap<number, string>;
  readonly clock: () => number;
  readonly ids: IdSource;
  readonly scheduler: TimerScheduler;
  status: TournamentStatus;
  lastWireSequence: number;
  actionDeadline: number | null;
  actionTimerGeneration: number;
  actionTimerHandle: TimerHandle | null;
  /** 最近一次建立行动权的决策点标识 `handNumber:street:seat`（Time Bank 机会复位判定）。 */
  lastDecisionPoint: string | null;
  /** time 模式定时升盲计时器（§8.1；只在 Hand 间生效）。 */
  blindTimerHandle: TimerHandle | null;
  blindTimerGeneration: number;
  currentHandId: string | null;
  /** 当前手开始时墙钟（手末 Commit Bundle 的 startedAt）。 */
  currentHandStartedAt: number;
  /** 已提交到 Writer 的手号（用于检测新手结算）。 */
  committedThroughHand: number;
  /** 已纳入 Commit Bundle 的 Engine 事件数（wire 水位：首序列 = 水位 + 1）。 */
  committedEventCount: number;
  /**
   * 引擎事件数组首个事件的内部 sequence（崩溃恢复用，docs/03 §4.3/§7.5）。
   * 正常开局为 0；恢复后 = 快照水位，使 wire 序列从快照处无缝延续。emit/commit 的
   * 数组切片基 = `lastWireSequence/committedEventCount - engineEventBase`（正常恒为 0）。
   */
  engineEventBase: number;
  currentLegalActions: LegalActions | null;
  stopAfterCurrentHand: boolean;
  /** Engine Critical Error 诊断（§7.4 冻结）；非冻结为 null。 */
  criticalDiagnostic: string | null;
  /** 幂等账本：`playerId:request:requestId` / `playerId:action:actionId` → Payload 摘要 + 结果（§7.3）。 */
  readonly idempotency: Map<string, { payloadHash: string; result: unknown }>;
}

export interface PlayerSeed {
  readonly playerId: string;
  /** tournament_players.id（开局快照分配；结果更新定位用）。 */
  readonly tournamentPlayerId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly startingStack: number;
}

export interface TournamentRuntimeDeps {
  readonly clock: () => number;
  readonly ids: IdSource;
  readonly scheduler: TimerScheduler;
}

/** 构造运行时：创建 Engine 权威状态并建立 seat ↔ player 映射（开局冻结）。 */
export function createTournamentRuntimeState(
  seed: {
    tournamentId: string;
    roomId: string;
    config: TournamentConfig;
    players: readonly PlayerSeed[];
    rng: RandomSource;
    engineOptions?: TournamentEngineOptions;
  },
  deps: TournamentRuntimeDeps,
): TournamentRuntimeState {
  const engine = new TournamentEngine(
    seed.config,
    seed.rng,
    seed.players.map((player) => ({
      seatIndex: player.seatIndex,
      name: player.displayName,
      kind: player.kind === "BOT" ? "bot" : "human",
    })),
    seed.engineOptions,
  );
  return buildRuntimeState(
    { tournamentId: seed.tournamentId, roomId: seed.roomId, players: seed.players },
    deps,
    engine,
    seed.config,
    { lastWireSequence: 0, committedEventCount: 0, committedThroughHand: 0, engineEventBase: 0 },
  );
}

/** 从权威手末 Snapshot 重建运行时（崩溃恢复，docs/04 §13；docs/03 §7.5）。 */
export function createRecoveredTournamentRuntimeState(
  seed: {
    tournamentId: string;
    roomId: string;
    players: readonly PlayerSeed[];
    /** 由 `TournamentEngine.restore` 从快照重建的引擎权威状态。 */
    engine: TournamentEngine;
    /** 恢复时点恢复给运行时的 wire 状态：`lastWireSequence` == `committedEventCount` == 快照 sequence。 */
    recovered: { lastWireSequence: number; committedThroughHand: number; engineEventBase: number };
  },
  deps: TournamentRuntimeDeps,
): TournamentRuntimeState {
  // 引擎 config 的 blindStructure 为 readonly；协议 TournamentConfig 需要可变副本。
  const engineConfig = seed.engine.getState().config;
  const config: TournamentConfig = {
    maxPlayers: engineConfig.maxPlayers,
    startingStack: engineConfig.startingStack,
    smallBlind: engineConfig.smallBlind,
    bigBlind: engineConfig.bigBlind,
    blindMode: engineConfig.blindMode,
    blindStructure: [...engineConfig.blindStructure],
    actionTime: engineConfig.actionTime,
    timeBank: engineConfig.timeBank,
  };
  return buildRuntimeState(
    { tournamentId: seed.tournamentId, roomId: seed.roomId, players: seed.players },
    deps,
    seed.engine,
    config,
    {
      lastWireSequence: seed.recovered.lastWireSequence,
      committedEventCount: seed.recovered.lastWireSequence,
      committedThroughHand: seed.recovered.committedThroughHand,
      engineEventBase: seed.recovered.engineEventBase,
    },
  );
}

/** 共享运行时初始化：建立 seat ↔ player 映射并组装不可变状态。 */
function buildRuntimeState(
  seed: { tournamentId: string; roomId: string; players: readonly PlayerSeed[] },
  deps: TournamentRuntimeDeps,
  engine: TournamentEngine,
  config: TournamentConfig,
  wire: { lastWireSequence: number; committedEventCount: number; committedThroughHand: number; engineEventBase: number },
): TournamentRuntimeState {
  const players = new Map<string, PlayerRuntimeRecord>();
  const seatToPlayer = new Map<number, string>();
  for (const player of seed.players) {
    players.set(player.playerId, {
      playerId: player.playerId,
      tournamentPlayerId: player.tournamentPlayerId,
      seatIndex: player.seatIndex,
      kind: player.kind,
      displayName: player.displayName,
      connected: true,
      graceHandle: null,
      graceGeneration: 0,
      timeBank: initialTimeBankState(config.timeBank),
    });
    seatToPlayer.set(player.seatIndex, player.playerId);
  }
  return {
    tournamentId: seed.tournamentId,
    roomId: seed.roomId,
    config,
    engine,
    players,
    seatToPlayer,
    clock: deps.clock,
    ids: deps.ids,
    scheduler: deps.scheduler,
    status: "RUNNING",
    lastWireSequence: wire.lastWireSequence,
    actionDeadline: null,
    actionTimerGeneration: 0,
    actionTimerHandle: null,
    lastDecisionPoint: null,
    blindTimerHandle: null,
    blindTimerGeneration: 0,
    currentHandId: null,
    currentHandStartedAt: 0,
    committedThroughHand: wire.committedThroughHand,
    committedEventCount: wire.committedEventCount,
    engineEventBase: wire.engineEventBase,
    currentLegalActions: null,
    stopAfterCurrentHand: false,
    criticalDiagnostic: null,
    idempotency: new Map(),
  };
}

/** 只读快照视图（供投影与测试；引擎状态即时读取）。 */
export interface TournamentRuntimeView {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly config: TournamentConfig;
  readonly status: TournamentStatus;
  readonly lastWireSequence: number;
  readonly actionDeadline: number | null;
  readonly currentHandId: string | null;
  readonly stopAfterCurrentHand: boolean;
  readonly engineState: TournamentState;
  readonly players: ReadonlyMap<string, PlayerRuntimeRecord>;
  readonly seatToPlayer: ReadonlyMap<number, string>;
  readonly timeBankRemainingMs: ReadonlyMap<string, number>;
  readonly currentLegalActions: LegalActions | null;
}

/** 组装不可变视图（供投影与测试）。 */
export function runtimeView(state: TournamentRuntimeState): TournamentRuntimeView {
  const timeBankRemainingMs = new Map<string, number>();
  for (const [playerId, record] of state.players) {
    timeBankRemainingMs.set(playerId, record.timeBank.secondsRemaining * 1000);
  }
  return {
    tournamentId: state.tournamentId,
    roomId: state.roomId,
    config: state.config,
    status: state.status,
    lastWireSequence: state.lastWireSequence,
    actionDeadline: state.actionDeadline,
    currentHandId: state.currentHandId,
    stopAfterCurrentHand: state.stopAfterCurrentHand,
    engineState: state.engine.getState(),
    players: state.players,
    seatToPlayer: state.seatToPlayer,
    timeBankRemainingMs,
    currentLegalActions: state.currentLegalActions,
  };
}
