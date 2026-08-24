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

export type TournamentStatus = "RUNNING" | "FINISHED" | "ABANDONED_NO_HUMAN";

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
  /** 最近一次建立行动权的座位（Time Bank 机会复位判定）。 */
  currentActorSeat: number | null;
  /** time 模式定时升盲计时器（§8.1；只在 Hand 间生效）。 */
  blindTimerHandle: TimerHandle | null;
  blindTimerGeneration: number;
  currentHandId: string | null;
  /** 当前手开始时墙钟（手末 Commit Bundle 的 startedAt）。 */
  currentHandStartedAt: number;
  /** 已提交到 Writer 的手号（用于检测新手结算）。 */
  committedThroughHand: number;
  /** 已纳入 Commit Bundle 的 Engine 事件数（用于按手切分事件）。 */
  committedEventCount: number;
  currentLegalActions: LegalActions | null;
  stopAfterCurrentHand: boolean;
  /** 幂等账本：actionId → Payload 摘要 + 最终结果（驻留内存期间保留，§7.3）。 */
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
      timeBank: initialTimeBankState(seed.config.timeBank),
    });
    seatToPlayer.set(player.seatIndex, player.playerId);
  }
  return {
    tournamentId: seed.tournamentId,
    roomId: seed.roomId,
    config: seed.config,
    engine,
    players,
    seatToPlayer,
    clock: deps.clock,
    ids: deps.ids,
    scheduler: deps.scheduler,
    status: "RUNNING",
    lastWireSequence: 0,
    actionDeadline: null,
    actionTimerGeneration: 0,
    actionTimerHandle: null,
    currentActorSeat: null,
    blindTimerHandle: null,
    blindTimerGeneration: 0,
    currentHandId: null,
    currentHandStartedAt: 0,
    committedThroughHand: 0,
    committedEventCount: 0,
    currentLegalActions: null,
    stopAfterCurrentHand: false,
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
