/**
 * Room/Lobby 权威状态机（docs/04-game-server-architecture.md §5）。
 *
 * - 服务端内存是 Lobby 唯一权威：seat/ready/connectionStatus/activeTournamentId
 *   只在内存（`rooms`/`room_players` 无对应列）；DB 只记录身份、成员关系、状态、
 *   配置与 Host（docs/03-data-model.md §5）。
 * - 状态机 `LOBBY → IN_GAME → FINISHED → LOBBY`，任意态可转 `CLOSED`。
 * - 每个状态迁移返回新的不可变 RoomState，`roomRevision` 单调递增，只增不回退；
 *   HTTP/WS 不得直接 mutate，必须经 Room 串行执行器。
 * - 开局条件（§5.3）：LOBBY、无活跃 Tournament、Host、至少 2 名真人、
 *   所有真人已入座、所有真人 Ready、expectedRoomRevision 精确匹配。
 */

import type { RoomSnapshot, TournamentConfig } from "@texas-holdem/protocol";
import { RoomDomainError } from "./room-errors";

export type RoomStatus = "LOBBY" | "IN_GAME" | "FINISHED" | "CLOSED";
export type LeaveReason = "USER_LEFT" | "DISCONNECT_TIMEOUT" | "ROOM_CLOSED";

export interface RoomMember {
  readonly playerId: string;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly seat: number | null;
  readonly ready: boolean;
  readonly connectionStatus: "CONNECTED" | "DISCONNECTED";
  readonly pokerStatus: "ACTIVE" | "EXIT_PENDING" | "WITHDRAWN" | "ELIMINATED";
  readonly joinedAt: number;
  readonly kind: "HUMAN" | "BOT";
  /** 服务器私有：token HMAC 摘要，仅用于鉴权，绝不进入投影。 */
  readonly tokenDigest: Buffer | null;
  readonly tokenKeyId: string | null;
}

export interface RoomMemberSeed {
  readonly playerId: string;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly kind?: "HUMAN" | "BOT";
  readonly tokenDigest?: Buffer | null;
  readonly tokenKeyId?: string | null;
  readonly joinedAt: number;
}

export interface RoomState {
  readonly roomId: string;
  readonly inviteCode: string | null;
  readonly status: RoomStatus;
  readonly roomRevision: number;
  readonly hostPlayerId: string | null;
  readonly config: TournamentConfig;
  readonly activeTournamentId: string | null;
  /** Room 内已创建场次数（用于分配 tournamentNo）。 */
  readonly tournamentCount: number;
  readonly members: ReadonlyMap<string, RoomMember>;
  readonly closedReason: string | null;
}

export interface LeaveInput {
  readonly reason: LeaveReason;
  readonly leftAt: number;
}

export interface StartTournamentInput {
  readonly actorPlayerId: string;
  readonly expectedRevision: number;
  readonly tournamentId: string;
}

function toMember(seed: RoomMemberSeed): RoomMember {
  return {
    playerId: seed.playerId,
    displayName: seed.displayName,
    displayNameKey: seed.displayNameKey,
    kind: seed.kind ?? "HUMAN",
    tokenDigest: seed.tokenDigest ?? null,
    tokenKeyId: seed.tokenKeyId ?? null,
    seat: null,
    ready: false,
    connectionStatus: "CONNECTED",
    pokerStatus: "ACTIVE",
    joinedAt: seed.joinedAt,
  };
}

/** 产生新状态：合并补丁并单调递增 roomRevision。 */
function advance(
  state: RoomState,
  patch: Partial<RoomState> & { members?: ReadonlyMap<string, RoomMember> },
): RoomState {
  return {
    ...state,
    ...patch,
    members: patch.members ?? state.members,
    roomRevision: state.roomRevision + 1,
  };
}

function requireMember(state: RoomState, playerId: string): RoomMember {
  const member = state.members.get(playerId);
  if (member === undefined) {
    throw new RoomDomainError("FORBIDDEN");
  }
  return member;
}

function requireLobby(state: RoomState): void {
  if (state.status !== "LOBBY") {
    throw new RoomDomainError("ROOM_LOCKED");
  }
}

function requireHost(state: RoomState, actorPlayerId: string): void {
  if (state.hostPlayerId !== actorPlayerId) {
    throw new RoomDomainError("NOT_HOST");
  }
}

function humanMemberCount(state: RoomState): number {
  let count = 0;
  for (const member of state.members.values()) {
    if (member.kind === "HUMAN") count += 1;
  }
  return count;
}

/** 创建房间：创建者即 Host，房间直接进入 LOBBY，revision 从 1 开始。 */
export function createRoomState(input: {
  roomId: string;
  inviteCode: string | null;
  host: RoomMemberSeed;
  config: TournamentConfig;
}): RoomState {
  const members = new Map<string, RoomMember>();
  members.set(input.host.playerId, toMember(input.host));
  return {
    roomId: input.roomId,
    inviteCode: input.inviteCode,
    status: "LOBBY",
    roomRevision: 1,
    hostPlayerId: input.host.playerId,
    config: input.config,
    activeTournamentId: null,
    tournamentCount: 0,
    members,
    closedReason: null,
  };
}

/** 加入：仅 LOBBY；严格拒绝满房/关闭房；昵称按 Unicode 默认大小写折叠判重。 */
export function joinRoom(state: RoomState, member: RoomMemberSeed): RoomState {
  if (state.status === "CLOSED") {
    throw new RoomDomainError("INVITE_EXPIRED");
  }
  if (state.status !== "LOBBY") {
    throw new RoomDomainError("ROOM_LOCKED");
  }
  if (humanMemberCount(state) >= state.config.maxPlayers) {
    throw new RoomDomainError("ROOM_FULL");
  }
  for (const existing of state.members.values()) {
    if (existing.displayNameKey === member.displayNameKey) {
      throw new RoomDomainError("NICKNAME_TAKEN");
    }
  }
  const next = new Map(state.members);
  next.set(member.playerId, toMember(member));
  return advance(state, { members: next });
}

/** 换座：只移动当前身份（playerId）；seat 为 null 表示离座；换座重置本人 Ready。 */
export function changeSeat(state: RoomState, playerId: string, seat: number | null): RoomState {
  requireLobby(state);
  requireMember(state, playerId);
  if (seat !== null) {
    if (seat < 0 || seat >= state.config.maxPlayers) {
      throw new RoomDomainError("INVALID_ACTION");
    }
    for (const other of state.members.values()) {
      if (other.playerId !== playerId && other.seat === seat) {
        throw new RoomDomainError("INVALID_ACTION");
      }
    }
  }
  return withMember(state, playerId, { seat, ready: false });
}

/** 设置 Ready：仅当前身份、仅 LOBBY。 */
export function setReady(state: RoomState, playerId: string, ready: boolean): RoomState {
  requireLobby(state);
  requireMember(state, playerId);
  return withMember(state, playerId, { ready });
}

/** 改配置：仅 Host、仅 LOBBY；任何配置变更重置全员 Ready（不得让旧 Ready 绕过条件）。 */
export function updateConfig(state: RoomState, actorPlayerId: string, config: TournamentConfig): RoomState {
  requireLobby(state);
  requireHost(state, actorPlayerId);
  if (config.maxPlayers < humanMemberCount(state)) {
    throw new RoomDomainError("INVALID_ACTION");
  }
  const members = new Map<string, RoomMember>();
  for (const member of state.members.values()) {
    // 容量缩小后清掉越界座位（同时重置 Ready），避免残留 seat >= maxPlayers 被写入开局快照。
    const seat = member.seat !== null && member.seat >= config.maxPlayers ? null : member.seat;
    members.set(member.playerId, { ...member, seat, ready: false });
  }
  return advance(state, { config, members });
}

/** 踢人：仅 Host、仅 LOBBY；不能踢自己或不存在成员。 */
export function kickPlayer(state: RoomState, actorPlayerId: string, targetPlayerId: string): RoomState {
  requireLobby(state);
  requireHost(state, actorPlayerId);
  if (targetPlayerId === actorPlayerId) {
    throw new RoomDomainError("INVALID_ACTION");
  }
  if (!state.members.has(targetPlayerId)) {
    throw new RoomDomainError("INVALID_ACTION");
  }
  const next = new Map(state.members);
  next.delete(targetPlayerId);
  return advance(state, { members: next });
}

/** 离开：移除成员；Host 主动离开立即把 Host 转给最早加入且在线的真人；末位真人离开则关闭房间。 */
export function leaveRoom(state: RoomState, playerId: string, _input: LeaveInput): RoomState {
  requireMember(state, playerId);
  const members = new Map(state.members);
  members.delete(playerId);
  let hostPlayerId = state.hostPlayerId;
  if (hostPlayerId === playerId) {
    hostPlayerId = pickNextHost({ ...state, members });
  }
  const humansRemaining = [...members.values()].some((member) => member.kind === "HUMAN");
  // 仅 LOBBY 的末位真人离开才关闭房间（§6.5）；IN_GAME 的无真人处置走
  // Tournament 撤回/弃赛流程（§6.6，TEX-20），本分支不得把进行中比赛留在半态。
  if (!humansRemaining && state.status === "LOBBY") {
    return advance(state, {
      members,
      hostPlayerId: null,
      status: "CLOSED",
      inviteCode: null,
      closedReason: "ABANDONED_NO_HUMAN",
    });
  }
  return advance(state, { members, hostPlayerId });
}

/**
 * Host 转移（显式可注入入口，供 TEX-21 的 Host Grace Timer 到期调用）：
 * 转给 joinedAt 最早、当前在线的真人；并列时按 playerId 升序。
 */
export function transferHost(state: RoomState): RoomState {
  return advance(state, { hostPlayerId: pickNextHost(state) });
}

function pickNextHost(state: RoomState): string | null {
  const candidates = [...state.members.values()]
    .filter(
      (member) =>
        member.kind === "HUMAN" &&
        member.connectionStatus === "CONNECTED" &&
        member.playerId !== state.hostPlayerId,
    )
    .sort((a, b) => {
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
    });
  return candidates[0]?.playerId ?? null;
}

/**
 * 开局：原子校验 LOBBY + 无活跃 Tournament + Host + ≥2 真人 + 全部入座 + 全部 Ready
 * + expectedRoomRevision；通过后冻结房间进入 IN_GAME 并记录 activeTournamentId。
 */
export function startTournament(state: RoomState, input: StartTournamentInput): RoomState {
  if (input.expectedRevision !== state.roomRevision) {
    throw new RoomDomainError("STALE_ROOM_STATE", {
      details: { currentRoomRevision: String(state.roomRevision) },
    });
  }
  requireLobby(state);
  if (state.activeTournamentId !== null) {
    throw new RoomDomainError("ROOM_LOCKED");
  }
  requireHost(state, input.actorPlayerId);
  const seatedHumans = [...state.members.values()].filter(
    (member) => member.kind === "HUMAN" && member.seat !== null,
  );
  if (seatedHumans.length < 2) {
    throw new RoomDomainError("INVALID_ACTION");
  }
  for (const member of state.members.values()) {
    if (member.kind !== "HUMAN") continue;
    if (member.seat === null) {
      throw new RoomDomainError("INVALID_ACTION");
    }
    if (!member.ready) {
      throw new RoomDomainError("INVALID_ACTION");
    }
  }
  return advance(state, {
    status: "IN_GAME",
    activeTournamentId: input.tournamentId,
    tournamentCount: state.tournamentCount + 1,
  });
}

/** 比赛终局（TEX-20 驱动）：仅当前活跃 Tournament 可迁移；迁移后 activeTournamentId 清空。 */
export function markTournamentFinished(state: RoomState, tournamentId: string): RoomState {
  if (state.status !== "IN_GAME" || state.activeTournamentId !== tournamentId) {
    throw new RoomDomainError("TOURNAMENT_NOT_ACTIVE");
  }
  return advance(state, { status: "FINISHED", activeTournamentId: null });
}

/** 再来一局：FINISHED → LOBBY，保留邀请码与配置（TEX-20 驱动）。 */
export function returnToLobby(state: RoomState): RoomState {
  if (state.status !== "FINISHED") {
    throw new RoomDomainError("ROOM_LOCKED");
  }
  return advance(state, { status: "LOBBY" });
}

/** 关闭房间：CLOSED、邀请码立即失效（置空）、记录关闭原因。 */
export function closeRoom(state: RoomState, reason: string): RoomState {
  return advance(state, { status: "CLOSED", inviteCode: null, closedReason: reason });
}

/**
 * 投影 RoomSnapshot（docs/02-protocol-spec.md §9.1）：
 * CLOSED 时 inviteCode=null；绝不包含 Token；玩家按 seat 升序、未入座最后按 playerId 稳定排序。
 */
export function projectRoomSnapshot(state: RoomState): RoomSnapshot {
  const players = [...state.members.values()].sort((a, b) => {
    if (a.seat !== null && b.seat !== null) return a.seat - b.seat;
    if (a.seat !== null) return -1;
    if (b.seat !== null) return 1;
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
  });
  return {
    snapshotVersion: 1,
    roomId: state.roomId,
    roomRevision: String(state.roomRevision),
    status: state.status,
    inviteCode: state.status === "CLOSED" ? null : state.inviteCode,
    hostPlayerId: state.hostPlayerId,
    config: state.config,
    activeTournamentId: state.activeTournamentId,
    players: players.map((member) => ({
      playerId: member.playerId,
      displayName: member.displayName,
      seat: member.seat,
      ready: member.ready,
      connectionStatus: member.connectionStatus,
      pokerStatus: member.pokerStatus,
    })),
  };
}

/** 更新单个成员（构造新成员对象，保持不可变）。 */
function withMember(state: RoomState, playerId: string, patch: Partial<RoomMember>): RoomState {
  const current = requireMember(state, playerId);
  const next = new Map(state.members);
  next.set(playerId, { ...current, ...patch });
  return advance(state, { members: next });
}
