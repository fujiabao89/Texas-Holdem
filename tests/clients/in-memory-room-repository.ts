/**
 * 内存版 RoomRepository Fake（TEX-28 Multiplayer/WS 层测试基础设施）。
 *
 * 契约与 `apps/game-server/src/infrastructure/persistence/repositories/rooms.ts`
 * 一致：相同的原子性语义（找不到目标行即抛 PersistenceError）与昵称唯一性
 * （重复 display_name_key 抛 cause.code = "23505"，供 room-persistence 的
 * NICKNAME_TAKEN 兜底路径识别）。仅用于协议/运行时行为测试；数据库事务、
 * 权限与持久化结论必须由真实 PostgreSQL 的 Integration 层测试支持
 * （docs/06-testing-strategy.md §3.2/§2.1）。
 */
import { PersistenceError } from "../../apps/game-server/src/infrastructure/persistence/repositories/errors";
import type {
  CreateRoomWithHostInput,
  InsertRoomPlayerInput,
  LeftReasonDb,
  RoomRepository,
  RoomStatusDb,
  RoomStatusFields,
  StartTournamentPersistenceInput,
} from "../../apps/game-server/src/infrastructure/persistence/repositories/rooms";

export interface InMemoryRoomState {
  readonly roomId: string;
  status: RoomStatusDb;
  configJson: unknown;
  hostPlayerId: string | null;
  inviteCode: string | null;
  mode: "MULTIPLAYER" | "SINGLE_PLAYER";
  closedReason?: string;
  closedAt?: Date;
  retentionExpiresAt?: Date;
  readonly players: Map<
    string,
    { displayName: string; displayNameKey: string; left: boolean; leftReason?: LeftReasonDb; leftAt?: Date }
  >;
  readonly tournaments: StartTournamentPersistenceInput[];
}

export interface InMemoryRoomRepository extends RoomRepository {
  /** 测试断言入口：读取内存中的控制面状态。 */
  room(roomId: string): InMemoryRoomState | undefined;
}

function uniqueViolation(roomId: string, displayNameKey: string): Error {
  // 与 PostgreSQL 23505 同构的错误形状（room-persistence 通过 cause.code 识别）。
  return new Error(`duplicate display_name_key room=${roomId} key=${displayNameKey}`, {
    cause: { code: "23505" },
  });
}

export function createInMemoryRoomRepository(): InMemoryRoomRepository {
  const rooms = new Map<string, InMemoryRoomState>();

  function requireRoom(roomId: string): InMemoryRoomState {
    const room = rooms.get(roomId);
    if (room === undefined) throw new PersistenceError(`room ${roomId} not found`);
    return room;
  }

  return {
    room(roomId) {
      return rooms.get(roomId);
    },
    async createRoomWithHost(input: CreateRoomWithHostInput) {
      if (rooms.has(input.roomId)) throw new PersistenceError(`room ${input.roomId} already exists`);
      const room: InMemoryRoomState = {
        roomId: input.roomId,
        status: input.initialStatus ?? "CREATED",
        configJson: input.configJson,
        hostPlayerId: null,
        inviteCode: input.inviteCode,
        mode: input.mode,
        players: new Map(),
        tournaments: [],
      };
      room.players.set(input.host.playerId, {
        displayName: input.host.displayName,
        displayNameKey: input.host.displayName.toLowerCase(),
        left: false,
      });
      room.hostPlayerId = input.host.playerId;
      rooms.set(input.roomId, room);
    },
    async insertRoomPlayer(input: InsertRoomPlayerInput) {
      const room = requireRoom(input.roomId);
      if (room.players.has(input.playerId)) throw new PersistenceError(`player ${input.playerId} already in room`);
      const displayNameKey = input.displayNameKey;
      for (const player of room.players.values()) {
        if (!player.left && player.displayNameKey === displayNameKey) throw uniqueViolation(input.roomId, displayNameKey);
      }
      room.players.set(input.playerId, { displayName: input.displayName, displayNameKey, left: false });
    },
    async setRoomStatus(roomId, status: RoomStatusDb, fields?: RoomStatusFields) {
      const room = requireRoom(roomId);
      room.status = status;
      if (status === "CLOSED") {
        if (fields?.closedReason === undefined || fields.closedAt === undefined) {
          throw new PersistenceError("CLOSED requires closedReason and closedAt");
        }
        room.closedReason = fields.closedReason;
        room.closedAt = fields.closedAt;
        room.retentionExpiresAt = fields.retentionExpiresAt ?? fields.closedAt;
      }
    },
    async updateRoomConfig(roomId, configJson) {
      requireRoom(roomId).configJson = configJson;
    },
    async setRoomHost(roomId, hostPlayerId) {
      requireRoom(roomId).hostPlayerId = hostPlayerId;
    },
    async markRoomPlayerLeft(roomId, playerId, reason: LeftReasonDb, leftAt: Date) {
      const room = requireRoom(roomId);
      const player = room.players.get(playerId);
      if (player === undefined) throw new PersistenceError(`player ${playerId} not in room ${roomId}`);
      player.left = true;
      player.leftReason = reason;
      player.leftAt = leftAt;
    },
    async markRoomPlayerLeftAndSetHost(roomId, playerId, reason: LeftReasonDb, leftAt: Date, newHostPlayerId, roomClosure) {
      const room = requireRoom(roomId);
      const player = room.players.get(playerId);
      if (player === undefined) throw new PersistenceError(`player ${playerId} not in room ${roomId}`);
      player.left = true;
      player.leftReason = reason;
      player.leftAt = leftAt;
      room.hostPlayerId = newHostPlayerId;
      if (roomClosure !== undefined) {
        room.status = "CLOSED";
        room.closedReason = roomClosure.reason;
        room.closedAt = roomClosure.closedAt;
        room.retentionExpiresAt = roomClosure.retentionExpiresAt;
      }
    },
    async startTournament(input: StartTournamentPersistenceInput) {
      requireRoom(input.roomId).tournaments.push(input);
    },
  };
}