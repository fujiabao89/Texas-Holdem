/**
 * 崩溃恢复编排（docs/03-data-model.md §4.3/§7.5；docs/04-game-server-architecture.md §13）。
 *
 * 进程启动屏障内调用：定位活跃（IN_GAME）比赛，**只**从权威、完整、版本兼容的数据恢复。
 *
 * 恢复顺序（§7.5）：
 * 1. `last_committed_sequence = 0` → 从已持久化的 Tournament 配置与锁定参赛者重新初始化
 *    （等价于正常开局，序列从 0 重新开始）。
 * 2. `last_committed_sequence > 0` → 读取对应手末 Snapshot，校验：
 *    - Schema/Engine 版本受支持（§5.6/§5.7）；
 *    - `state_checksum` 与快照 `state` 一致（损坏检测，§5.7）；
 *    - Snapshot.sequence 与水位线对齐且已提交事件 1..sequence 连续无缺口；
 *    - `state.nextSequence` 与 Snapshot.sequence 一致（序列连续性）。
 *    通过 → `TournamentEngine.restore` 重建引擎 → 注册恢复运行时（wire 序列从快照继续）。
 * 3. 最新 Snapshot 不可验证 → 按 sequence 向前退回上一个可验证 Snapshot（§4.3/§7.5）；
 *    退回时对 > 该 Snapshot 的已提交区域做恢复回退（删事件/手/快照、复位水位、
 *    重置 tournament_players），使 DB 与恢复的内存状态一致。
 * 4. 无可验证 Snapshot → 隔离该 Tournament（不注册运行时）、记录 Critical、拒绝其动作，
 *    等待人工处置（§13「不得猜测拼接状态」）；其他比赛正常启动。
 *
 * 恢复后不重建旧进程 Timer 回调或 connectionEpoch；所有连接视为断开（§13）。
 */

import { sha256Checksum } from "../infrastructure/persistence/checksum";
import type {
  CommittedSnapshotRecord,
  RecoveryRepository,
} from "../infrastructure/persistence/repositories/recovery";
import { TournamentEngine } from "@texas-holdem/poker-engine";
import type { RandomSource, TournamentEngineOptions, TournamentState } from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";
import type { TournamentManager } from "../tournaments/tournament-manager";
import type { PlayerSeed } from "../tournaments/tournament-runtime";
import { ENGINE_VERSION, SCHEMA_VERSION } from "../tournaments/tournament-persistence";
import type { IdSource } from "../rooms/id-source";
import type { TimerScheduler } from "../scheduler/timer-scheduler";

export interface RecoveryDeps {
  readonly recoveryRepo: RecoveryRepository;
  readonly manager: TournamentManager;
  readonly clock: () => number;
  readonly ids: IdSource;
  readonly scheduler: TimerScheduler;
  /** 每场恢复的引擎随机源（生产安全随机；测试注入 seed 源）。 */
  readonly rngFactory: () => RandomSource;
  readonly engineOptionsFactory?: () => TournamentEngineOptions;
  /** 无可验证恢复根时上报（Critical 诊断；不猜测拼接）。 */
  readonly onUnrecoverable?: (tournamentId: string, reason: string) => void;
}

export interface RecoverySummary {
  readonly recovered: readonly { tournamentId: string; fromSequence: bigint }[];
  readonly reinitialized: readonly { tournamentId: string }[];
  readonly unrecovered: readonly { tournamentId: string; reason: string }[];
}

interface ValidatedSnapshot {
  readonly snapshot: CommittedSnapshotRecord;
  readonly state: TournamentState;
}

interface ActiveTournamentPlayers {
  readonly id: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly startingStack: bigint;
}

export async function recoverActiveTournaments(deps: RecoveryDeps): Promise<RecoverySummary> {
  const active = await deps.recoveryRepo.listActiveTournaments();
  const recovered: { tournamentId: string; fromSequence: bigint }[] = [];
  const reinitialized: { tournamentId: string }[] = [];
  const unrecovered: { tournamentId: string; reason: string }[] = [];

  for (const record of active) {
    const outcome = await recoverOne(
      deps,
      record.tournamentId,
      record.roomId,
      record.configJson,
      record.lastCommittedSequence,
      record.players,
    );
    if (outcome.kind === "recovered") {
      recovered.push({ tournamentId: record.tournamentId, fromSequence: outcome.fromSequence });
    } else if (outcome.kind === "reinitialized") {
      reinitialized.push({ tournamentId: record.tournamentId });
    } else {
      unrecovered.push({ tournamentId: record.tournamentId, reason: outcome.reason });
      deps.onUnrecoverable?.(record.tournamentId, outcome.reason);
    }
  }
  return { recovered, reinitialized, unrecovered };
}

type RecoverOutcome =
  | { kind: "recovered"; fromSequence: bigint }
  | { kind: "reinitialized" }
  | { kind: "unrecoverable"; reason: string };

async function recoverOne(
  deps: RecoveryDeps,
  tournamentId: string,
  roomId: string,
  configJson: unknown,
  lastCommittedSequence: bigint,
  players: readonly ActiveTournamentPlayers[],
): Promise<RecoverOutcome> {
  // §4.3：首手尚未完整提交 → 从配置 + 锁定参赛者重新初始化（恢复感知：断开 + 宽限，§13）。
  if (lastCommittedSequence === 0n) {
    deps.manager.createRecoveredFresh({
      tournamentId,
      roomId,
      config: configJson as TournamentConfig,
      players: toPlayerSeeds(players),
      rng: deps.rngFactory(),
    });
    return { kind: "reinitialized" };
  }

  const snapshots = await deps.recoveryRepo.listSnapshots(tournamentId);
  if (snapshots.length === 0) {
    return { kind: "unrecoverable", reason: "no committed snapshot for watermark" };
  }

  // 候选按 sequence 降序；优先水位线 Snapshot，不可验证则向前退回。
  let fallback: ValidatedSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.sequence > lastCommittedSequence) continue; // 不应出现；防御性跳过
    const validated = await tryValidate(deps, tournamentId, snapshot);
    if (validated !== null) {
      fallback = validated;
      break;
    }
  }
  if (fallback === null) {
    return { kind: "unrecoverable", reason: "no verifiable snapshot (orphan/gap/checksum/version)" };
  }

  // 向前退回：最新不可验证、回退到上一可验证 Snapshot → 重置 DB 到该水位（§4.3/§7.5）。
  if (fallback.snapshot.sequence !== lastCommittedSequence) {
    await deps.recoveryRepo.rollbackToSnapshot(
      tournamentId,
      fallback.snapshot.sequence,
      fallback.state.participants.map((p) => ({
        seatIndex: p.seatIndex,
        status: p.status,
        chips: p.chips,
        rank: p.finish ? p.finish.placementRange.from : null,
      })),
    );
  }

  const engine = TournamentEngine.restore(
    fallback.state,
    deps.rngFactory(),
    deps.engineOptionsFactory?.(),
  );
  deps.manager.createRecovered({
    tournamentId,
    roomId,
    players: toPlayerSeeds(players),
    engine,
    recovered: {
      // 恢复后 wire 序列从快照水位延续：lastWireSequence == committedEventCount ==
      // engineEventBase == 快照 sequence（state.nextSequence 已校验相等）。
      lastWireSequence: Number(fallback.snapshot.sequence),
      committedThroughHand: fallback.state.handNumber,
      engineEventBase: Number(fallback.snapshot.sequence),
      // 还原每玩家剩余 Time Bank（P1-B）；旧快照无 serverTimeBank → 满余额回退。
      timeBank: extractServerTimeBank(fallback.state),
    },
  });
  return { kind: "recovered", fromSequence: fallback.snapshot.sequence };
}

/** 校验快照可验证性；不可验证返回 null（调用方向前退回）。 */
async function tryValidate(
  deps: RecoveryDeps,
  tournamentId: string,
  snapshot: CommittedSnapshotRecord,
): Promise<ValidatedSnapshot | null> {
  // Schema/Engine 版本兼容（§5.6/§5.7）：未知版本拒绝猜测恢复。
  // SCHEMA_VERSION=2 起快照 state 必须携带 serverTimeBank companion；v1 旧格式
  // 缺少该权威余额，接受会把已消耗 Time Bank 重置为满值 → 拒绝（P1-C）。
  if (snapshot.schemaVersion !== SCHEMA_VERSION) return null;
  if (snapshot.engineVersion !== ENGINE_VERSION) return null;
  // 结构校验：state 必须是手末边界内部 GameState。
  const state = snapshot.state;
  if (!isHandBoundaryState(state)) return null;
  // 防御性：声称 v2 的 Time Bank 启用快照若仍缺少/为空 serverTimeBank → 拒绝，不回退满余额。
  if (isTimeBankEnabled(state) && extractServerTimeBank(state) === undefined) return null;
  // state_checksum 与 state 一致（canonical JSON 往返稳定，§5.7）。
  const recomputed = sha256Checksum(state);
  if (Buffer.compare(recomputed, snapshot.stateChecksum) !== 0) return null;
  // 事件连续性：已提交事件 1..snapshot.sequence 无缺口（§7.5「事件缺口拒绝」）。
  const continuous = await deps.recoveryRepo.hasCommittedEventsThrough(
    tournamentId,
    snapshot.sequence,
  );
  if (!continuous) return null;
  // 序列连续性：state.nextSequence 必须等于快照水位（恢复后 wire 无缝衔接的前提）。
  if (Number(state.nextSequence) !== Number(snapshot.sequence)) return null;
  return { snapshot, state };
}

function isHandBoundaryState(value: unknown): value is TournamentState {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.handInProgress === "boolean" &&
    s.handInProgress === false &&
    typeof s.nextSequence === "number" &&
    typeof s.handNumber === "number" &&
    typeof s.phase === "string" &&
    Array.isArray(s.participants)
  );
}

/** 快照配置是否启用 Time Bank（timeBank > 0）——启用时缺少 serverTimeBank 即不可恢复。 */
function isTimeBankEnabled(state: TournamentState): boolean {
  return typeof state.config?.timeBank === "number" && state.config.timeBank > 0;
}

/** 从快照 state 提取服务端权威的每玩家剩余 Time Bank（P1-B）；旧快照无该键 → undefined（满余额回退）。 */
function extractServerTimeBank(state: TournamentState): Record<string, number> | undefined {
  const server = (state as TournamentState & { serverTimeBank?: unknown }).serverTimeBank;
  if (server === undefined || server === null || typeof server !== "object") return undefined;
  const result: Record<string, number> = {};
  for (const [playerId, seconds] of Object.entries(server as Record<string, unknown>)) {
    if (typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 0) {
      result[playerId] = seconds;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toPlayerSeeds(players: readonly ActiveTournamentPlayers[]): PlayerSeed[] {
  return players.map((p) => ({
    playerId: p.playerId,
    tournamentPlayerId: p.id,
    displayName: p.displayName,
    seatIndex: p.seatIndex,
    kind: p.kind,
    startingStack: Number(p.startingStack),
  }));
}
