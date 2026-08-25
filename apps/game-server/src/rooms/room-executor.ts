/**
 * Room/Lobby 串行执行器（docs/04-game-server-architecture.md §5.7）。
 *
 * 每个 Room 自创建起拥有唯一串行队列。加入、离开、换座、Ready、配置、踢人、
 * Host 转移、开局锁定与状态迁移都必须经 `submit` 进入该队列；HTTP/WS 入口
 * 不得直接 mutate Room 状态。入队后在同一任务内：先基于最新状态做纯迁移
 * （可能抛 `RoomDomainError` 业务拒绝）→ 控制面持久化（先提交后确认）→
 * 成功后才把新状态提交为当前状态，避免检查后写入竞态与半提交。
 */

import type { TournamentConfig } from "@texas-holdem/protocol";
import { RoomDomainError } from "./room-errors";
import type { IdSource } from "./id-source";
import type { RoomPersistence } from "./room-persistence";
import {
  changeSeat,
  closeRoom,
  joinRoom as joinRoomTransition,
  kickPlayer,
  leaveRoom,
  markTournamentFinished,
  returnToLobby,
  setConnectionStatus,
  type LeaveReason,
  type RoomMemberSeed,
  type RoomState,
  setReady,
  startTournament as startTournamentTransition,
  transferHost,
  updateConfig,
} from "./room-runtime";
import type { TournamentStartRequest } from "./tournament-starter";

export type RoomCommand =
  | { type: "JOIN"; member: RoomMemberSeed }
  | { type: "LEAVE"; playerId: string; reason: LeaveReason; leftAt: number; afterTournamentWithdrawal?: boolean; connectionEpoch?: number }
  | { type: "SET_READY"; playerId: string; ready: boolean; connectionEpoch?: number }
  | { type: "SET_CONNECTION_STATUS"; playerId: string; connectionStatus: "CONNECTED" | "DISCONNECTED" }
  | { type: "CHANGE_SEAT"; playerId: string; seat: number | null; expectedRevision?: number }
  | { type: "UPDATE_CONFIG"; actorPlayerId: string; config: TournamentConfig; expectedRevision?: number }
  | { type: "KICK_PLAYER"; actorPlayerId: string; targetPlayerId: string; expectedRevision?: number }
  | { type: "TRANSFER_HOST" }
  | { type: "START_TOURNAMENT"; actorPlayerId: string; expectedRevision: number; tournamentId: string }
  | { type: "TOURNAMENT_FINISHED"; tournamentId: string }
  | { type: "RETURN_TO_LOBBY" }
  | { type: "CLOSE_ROOM"; reason: string };

export interface RoomCommandResult {
  readonly state: RoomState;
  /** START_TOURNAMENT 成功时携带新建的 tournamentId（响应需要）。 */
  readonly tournamentId?: string;
}

export interface RoomRuntimeDeps {
  readonly persistence: RoomPersistence;
  readonly ids: IdSource;
  /** Transport-private epoch guard, checked after this Room command obtains queue ownership. */
  readonly isConnectionCurrent?: (roomId: string, playerId: string, epoch: number) => boolean;
}

export class RoomRuntime {
  private state: RoomState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deps: RoomRuntimeDeps;

  constructor(state: RoomState, deps: RoomRuntimeDeps) {
    this.state = state;
    this.deps = deps;
  }

  /** 当前权威状态（只读；只有串行队列任务可替换）。 */
  get current(): RoomState {
    return this.state;
  }

  /** 把命令投递到本 Room 的串行队列；同 Room 任务严格顺序执行。 */
  submit(command: RoomCommand): Promise<RoomCommandResult> {
    const run = this.queue.then(() => this.process(command));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async process(command: RoomCommand): Promise<RoomCommandResult> {
    const before = this.state;
    const { next, persisted, tournamentId } = this.apply(before, command);
    if (persisted) {
      await this.persist(before, next, command);
    }
    this.state = next;
    return { state: next, tournamentId };
  }

  /** 计算纯迁移结果；业务拒绝在此抛出，持久化失败不提交内存状态。 */
  private apply(
    before: RoomState,
    command: RoomCommand,
  ): { next: RoomState; persisted: boolean; tournamentId?: string } {
    switch (command.type) {
      case "JOIN":
        return { next: joinRoomTransition(before, command.member), persisted: true };
      case "LEAVE":
        assertConnectionCurrent(before, command, this.deps);
        return {
          next: leaveRoom(before, command.playerId, {
            reason: command.reason,
            leftAt: command.leftAt,
            afterTournamentWithdrawal: command.afterTournamentWithdrawal,
          }),
          persisted: true,
        };
      case "SET_READY":
        assertConnectionCurrent(before, command, this.deps);
        return { next: setReady(before, command.playerId, command.ready), persisted: false };
      case "SET_CONNECTION_STATUS":
        return { next: setConnectionStatus(before, command.playerId, command.connectionStatus), persisted: false };
      case "CHANGE_SEAT":
        assertRevision(before, command.expectedRevision);
        return { next: changeSeat(before, command.playerId, command.seat), persisted: false };
      case "UPDATE_CONFIG":
        assertRevision(before, command.expectedRevision);
        return { next: updateConfig(before, command.actorPlayerId, command.config), persisted: true };
      case "KICK_PLAYER":
        assertRevision(before, command.expectedRevision);
        return { next: kickPlayer(before, command.actorPlayerId, command.targetPlayerId), persisted: true };
      case "TRANSFER_HOST":
        return { next: transferHost(before), persisted: true };
      case "START_TOURNAMENT":
        return {
          next: startTournamentTransition(before, {
            actorPlayerId: command.actorPlayerId,
            expectedRevision: command.expectedRevision,
            tournamentId: command.tournamentId,
          }),
          persisted: true,
          tournamentId: command.tournamentId,
        };
      case "TOURNAMENT_FINISHED":
        return { next: markTournamentFinished(before, command.tournamentId), persisted: true };
      case "RETURN_TO_LOBBY":
        return { next: returnToLobby(before), persisted: true };
      case "CLOSE_ROOM":
        return { next: closeRoom(before, command.reason), persisted: true };
    }
  }

  /** 控制面先提交：持久化成功后客户端才收到成功结果；失败不提交内存状态。 */
  private async persist(before: RoomState, next: RoomState, command: RoomCommand): Promise<void> {
    const p = this.deps.persistence;
    switch (command.type) {
      case "JOIN":
        await p.insertMember({
          roomId: before.roomId,
          playerId: command.member.playerId,
          displayName: command.member.displayName,
          tokenDigest: command.member.tokenDigest ?? Buffer.alloc(0),
          tokenKeyId: command.member.tokenKeyId ?? "",
        });
        return;
      case "LEAVE":
        // 原子离开：同一事务内标记 LEFT、回填新 Host；末位真人离开时同事务关闭房间。
        await p.leaveRoomMember(
          before.roomId,
          command.playerId,
          command.reason,
          command.leftAt,
          next.hostPlayerId,
          next.status === "CLOSED"
            ? { reason: next.closedReason ?? "ABANDONED_NO_HUMAN", closedAt: this.deps.ids.now() }
            : undefined,
        );
        return;
      case "UPDATE_CONFIG":
        await p.updateRoomConfig(before.roomId, command.config);
        return;
      case "KICK_PLAYER":
        await p.markMemberLeft(before.roomId, command.targetPlayerId, "USER_LEFT", this.deps.ids.now());
        return;
      case "TRANSFER_HOST":
        await p.setRoomHost(before.roomId, next.hostPlayerId);
        return;
      case "START_TOURNAMENT": {
        await p.startTournament(buildTournamentStartRequest(before, command, this.deps.ids));
        return;
      }
      case "TOURNAMENT_FINISHED":
        await p.setRoomStatus(before.roomId, "FINISHED");
        return;
      case "RETURN_TO_LOBBY":
        await p.setRoomStatus(before.roomId, "LOBBY");
        return;
      case "CLOSE_ROOM":
        await p.setRoomStatus(before.roomId, "CLOSED", {
          closedReason: command.reason,
          closedAt: this.deps.ids.now(),
        });
        return;
      default:
        return;
    }
  }
}

/** 取得执行权后复核 expectedRoomRevision（docs/04-game-server-architecture.md §5.7）。 */
function assertRevision(state: RoomState, expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && expectedRevision !== state.roomRevision) {
    throw new RoomDomainError("STALE_ROOM_STATE", {
      details: { currentRoomRevision: String(state.roomRevision) },
    });
  }
}

/** Re-check socket ownership only after the Room queue grants execution. */
function assertConnectionCurrent(
  state: RoomState,
  command: Extract<RoomCommand, { type: "LEAVE" | "SET_READY" }>,
  deps: RoomRuntimeDeps,
): void {
  if (command.connectionEpoch !== undefined && deps.isConnectionCurrent !== undefined && !deps.isConnectionCurrent(state.roomId, command.playerId, command.connectionEpoch)) {
    throw new RoomDomainError("SESSION_REPLACED");
  }
}

/** 开局：把当前已入座真人冻结为 Tournament 参赛快照（起始筹码 = config.startingStack）。 */
function buildTournamentStartRequest(
  state: RoomState,
  command: Extract<RoomCommand, { type: "START_TOURNAMENT" }>,
  ids: IdSource,
): TournamentStartRequest {
  const players = [...state.members.values()]
    .filter((member) => member.kind === "HUMAN" && member.seat !== null)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
    .map((member) => ({
      id: ids.uuid(),
      playerId: member.playerId,
      displayName: member.displayName,
      seatIndex: member.seat as number,
      kind: "HUMAN" as const,
      startingStack: BigInt(state.config.startingStack),
    }));
  return {
    roomId: state.roomId,
    tournamentId: command.tournamentId,
    tournamentNo: state.tournamentCount + 1,
    config: state.config,
    players,
  };
}
