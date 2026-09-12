/** 完整启动屏障：先验证恢复根，再注册 Room/身份，最后启动唯一最新 Tournament。 */
import {
  DisplayNameSchema,
  InviteCodeSchema,
  TournamentConfigSchema,
} from "@texas-holdem/protocol";
import { stableStringify } from "../infrastructure/persistence/checksum";
import { normalizeDisplayNameKey } from "../infrastructure/persistence/display-name";
import { PersistenceError } from "../infrastructure/persistence/repositories/errors";
import type {
  RoomRecoveryRecord,
  RoomRecoveryRepository,
} from "../infrastructure/persistence/repositories/room-recovery";
import type { RoomRepository } from "../infrastructure/persistence/repositories/rooms";
import type { RoomManager } from "../rooms/room-manager";
import type { RoomMember, RoomState } from "../rooms/room-runtime";
import type { TournamentManager } from "../tournaments/tournament-manager";
import {
  prepareTournamentRecovery,
  type RecoveryPlanDeps,
  type TournamentRecoveryPlan,
} from "./recovery";

export interface RoomRecoveryDeps extends RecoveryPlanDeps {
  readonly roomRecoveryRepo: RoomRecoveryRepository;
  readonly roomRepository: Pick<RoomRepository, "setRoomStatus">;
  readonly roomManager: RoomManager;
  readonly manager: TournamentManager;
  readonly tokenKeyId: string;
  readonly onIsolated?: (context: {
    roomId: string;
    tournamentId?: string;
    reason: string;
  }) => void;
}

export interface RoomRecoverySummary {
  readonly restoredRooms: readonly string[];
  readonly skippedRooms: readonly string[];
  readonly isolated: readonly { roomId: string; tournamentId?: string; reason: string }[];
  readonly recovered: readonly { tournamentId: string; fromSequence: bigint }[];
  readonly reinitialized: readonly { tournamentId: string }[];
}

class InvalidRecovery extends Error {}
type RecoveryIoOperation =
  | "list-rooms"
  | "list-active-tournaments"
  | "list-snapshots"
  | "check-event-continuity"
  | "rollback-snapshot"
  | "reserve-room-revision"
  | "set-room-status";

/** 固定错误码可安全进入启动日志；不保留驱动错误、SQL 参数或凭证内容。 */
class RecoveryInfrastructureError extends Error {
  constructor(operation: RecoveryIoOperation) {
    super(`ROOM_RECOVERY_INFRASTRUCTURE_FAILED:${operation}`);
    this.name = "RecoveryInfrastructureError";
  }
}

async function recoveryIo<T>(
  operation: RecoveryIoOperation,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    // 已知仓储不一致（目标缺失、号段耗尽等）仍交逐房隔离；意外 I/O 必须阻止监听。
    if (error instanceof PersistenceError) throw error;
    throw new RecoveryInfrastructureError(operation);
  }
}

function requireFact(valid: boolean, reason: string): asserts valid {
  if (!valid) throw new InvalidRecovery(reason);
}

// 重入调用共享同一屏障；完成后重复调用只跳过已注册 Room，不覆盖活跃内存状态。
const barriers = new WeakMap<RoomManager, Promise<RoomRecoverySummary>>();
export function recoverRoomsOnStartup(deps: RoomRecoveryDeps): Promise<RoomRecoverySummary> {
  const existing = barriers.get(deps.roomManager);
  if (existing !== undefined) return existing;
  const pending = recoverRooms(deps).finally(() => barriers.delete(deps.roomManager));
  barriers.set(deps.roomManager, pending);
  return pending;
}

async function recoverRooms(deps: RoomRecoveryDeps): Promise<RoomRecoverySummary> {
  // 整体数据库不可用时阻止监听；逐 Room 验证错误只隔离该 Room。
  const records = await recoveryIo("list-rooms", () =>
    deps.roomRecoveryRepo.listRecoverableRooms(),
  );
  const activeRecords = await recoveryIo("list-active-tournaments", () =>
    deps.recoveryRepo.listActiveTournaments(),
  );
  // 只包装真正的仓储边界，不把 Engine 校验、随机源或 Runtime 注册异常归类为 DB 故障。
  const planDeps: RecoveryPlanDeps = {
    ...deps,
    recoveryRepo: {
      ...deps.recoveryRepo,
      listSnapshots: (id) =>
        recoveryIo("list-snapshots", () => deps.recoveryRepo.listSnapshots(id)),
      hasCommittedEventsThrough: (id, sequence) =>
        recoveryIo("check-event-continuity", () =>
          deps.recoveryRepo.hasCommittedEventsThrough(id, sequence),
        ),
      rollbackToSnapshot: (id, sequence, participants) =>
        recoveryIo("rollback-snapshot", () =>
          deps.recoveryRepo.rollbackToSnapshot(id, sequence, participants),
        ),
    },
  };
  const restoredRooms: string[] = [];
  const skippedRooms: string[] = [];
  const isolated: { roomId: string; tournamentId?: string; reason: string }[] = [];
  const recovered: { tournamentId: string; fromSequence: bigint }[] = [];
  const reinitialized: { tournamentId: string }[] = [];
  const isolate = (context: (typeof isolated)[number]): void => {
    isolated.push(context);
    deps.onIsolated?.(context);
  };
  for (const active of activeRecords) {
    if (!records.some((room) => room.roomId === active.roomId)) {
      isolate({
        roomId: active.roomId,
        tournamentId: active.tournamentId,
        reason: "missing-or-closed-room",
      });
    }
  }
  for (const record of records) {
    if (deps.roomManager.findRoom(record.roomId) !== undefined) {
      skippedRooms.push(record.roomId);
      continue;
    }
    let registered = false;
    const latest = record.tournaments.find((t) => t.tournamentNo === record.tournamentCount);
    try {
      const base = validateRoom(record, deps.tokenKeyId);
      for (const old of record.tournaments) {
        if (old !== latest && old.status === "IN_GAME")
          isolate({
            roomId: record.roomId,
            tournamentId: old.tournamentId,
            reason: "superseded-tournament",
          });
      }
      let plan: Exclude<TournamentRecoveryPlan, { kind: "unrecoverable" }> | undefined;
      if (record.status === "IN_GAME" || record.status === "FINISHED") {
        requireFact(latest !== undefined, "missing-latest-tournament");
        requireFact(
          deps.manager.getView(latest.tournamentId) === undefined,
          "tournament-already-registered-without-room",
        );
        requireFact(
          stableStringify(TournamentConfigSchema.parse(latest.configJson)) ===
            stableStringify(base.config),
          "room-tournament-config-conflict",
        );
        const candidate = await prepareTournamentRecovery(
          planDeps,
          latest.tournamentId,
          record.roomId,
          latest.configJson,
          latest.lastCommittedSequence,
          latest.players,
        );
        requireFact(
          candidate.kind !== "unrecoverable",
          candidate.kind === "unrecoverable" ? candidate.reason : "invalid-checkpoint",
        );
        plan = candidate;
        requireFact(
          latest.status === "IN_GAME" || plan.state.phase === "finished",
          "terminal-state-conflict",
        );
        requireFact(latest.status !== "ABANDONED_NO_HUMAN", "abandoned-room-not-closed");
        const lockedIds = new Set(latest.players.map((p) => p.playerId));
        for (const member of base.members.values()) {
          requireFact(lockedIds.has(member.playerId), "unlocked-room-member");
        }
        for (const player of latest.players) {
          const participant = plan.state.participants.find(
            (p) => p.seatIndex === player.seatIndex,
          )!;
          const member = base.members.get(player.playerId);
          requireFact(
            member !== undefined || ["WITHDRAWN", "ELIMINATED"].includes(participant.status),
            "active-checkpoint-player-left-room",
          );
          if (member !== undefined) {
            requireFact(
              member.kind === player.kind && member.displayName === player.displayName,
              "member-locked-player-conflict",
            );
            base.members.set(member.playerId, {
              ...member,
              seat: player.seatIndex,
              pokerStatus: participant.status,
            });
          }
        }
      } else {
        requireFact(
          latest === undefined || latest.status !== "IN_GAME",
          "lobby-active-tournament-conflict",
        );
      }
      const status =
        plan === undefined ? "LOBBY" : plan.state.phase === "finished" ? "FINISHED" : "IN_GAME";
      const lease = await recoveryIo("reserve-room-revision", () =>
        deps.roomRecoveryRepo.reserveRoomRevision(record.roomId),
      );
      // 在任何运行时可见前完成回退/控制面协调；没有半恢复 Room 可以被认证。
      await plan?.commit();
      if (status !== record.status)
        await recoveryIo("set-room-status", () =>
          deps.roomRepository.setRoomStatus(record.roomId, status),
        );
      const state: RoomState = {
        ...base,
        status,
        roomRevision: lease.initial,
        activeTournamentId: status === "IN_GAME" ? latest!.tournamentId : null,
      };
      deps.roomManager.registerRecovered(state, lease.ceiling);
      registered = true;
      if (plan !== undefined && status === "IN_GAME") {
        if (plan.kind === "recovered") {
          await deps.manager.createRecovered(plan.input);
          recovered.push({
            tournamentId: plan.input.tournamentId,
            fromSequence: plan.fromSequence,
          });
        } else {
          await deps.manager.createRecoveredFresh(plan.input);
          reinitialized.push({ tournamentId: plan.input.tournamentId });
        }
      }
      restoredRooms.push(record.roomId);
    } catch (error) {
      if (registered) deps.roomManager.unregisterRecovered(record.roomId);
      if (error instanceof RecoveryInfrastructureError) throw error;
      isolate({
        roomId: record.roomId,
        tournamentId: latest?.tournamentId,
        reason:
          error instanceof InvalidRecovery
            ? error.message
            : "recovery-validation-or-registration-failed",
      });
    }
  }
  return { restoredRooms, skippedRooms, isolated, recovered, reinitialized };
}

function validateRoom(record: RoomRecoveryRecord, tokenKeyId: string) {
  const parsed = TournamentConfigSchema.safeParse(record.configJson);
  requireFact(parsed.success, "invalid-room-config");
  requireFact(
    record.mode === "MULTIPLAYER"
      ? InviteCodeSchema.safeParse(record.inviteCode).success
      : record.inviteCode === null,
    "invalid-invite-mode",
  );
  requireFact(
    Number.isSafeInteger(record.tournamentCount) && record.tournamentCount >= 0,
    "invalid-tournament-count",
  );
  requireFact(
    record.tournaments.every(
      (t) =>
        Number.isInteger(t.tournamentNo) &&
        t.tournamentNo > 0 &&
        t.tournamentNo <= record.tournamentCount,
    ) && new Set(record.tournaments.map((t) => t.tournamentNo)).size === record.tournaments.length,
    "ambiguous-tournament-order",
  );
  requireFact(
    record.members.length > 0 && record.members.length <= parsed.data.maxPlayers,
    "invalid-member-count",
  );
  const members = new Map<string, RoomMember>();
  const names = new Set<string>();
  for (const member of record.members) {
    requireFact(
      !members.has(member.playerId) &&
        !names.has(member.displayNameKey) &&
        DisplayNameSchema.safeParse(member.displayName).success &&
        normalizeDisplayNameKey(member.displayName) === member.displayNameKey &&
        Number.isFinite(member.joinedAt.getTime()),
      "invalid-member-identity",
    );
    if (member.kind === "HUMAN") {
      requireFact(
        Buffer.isBuffer(member.tokenDigest) &&
          member.tokenDigest.length === 32 &&
          member.tokenKeyId === tokenKeyId,
        "unavailable-member-credential",
      );
    } else {
      requireFact(
        member.kind === "BOT" && member.tokenDigest === null && member.tokenKeyId === null,
        "invalid-bot-credential",
      );
    }
    names.add(member.displayNameKey);
    members.set(member.playerId, {
      ...member,
      tokenDigest: member.tokenDigest === null ? null : Buffer.from(member.tokenDigest),
      joinedAt: member.joinedAt.getTime(),
      seat: null,
      ready: false,
      connectionStatus: "DISCONNECTED",
      pokerStatus: "ACTIVE",
    });
  }
  requireFact(
    record.hostPlayerId !== null && members.get(record.hostPlayerId)?.kind === "HUMAN",
    "missing-active-human-host",
  );
  return {
    roomId: record.roomId,
    inviteCode: record.inviteCode,
    hostPlayerId: record.hostPlayerId,
    config: parsed.data,
    tournamentCount: record.tournamentCount,
    members,
    closedReason: null,
  };
}
