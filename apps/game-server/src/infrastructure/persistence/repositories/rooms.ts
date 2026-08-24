import { and, eq } from "drizzle-orm";
import type { Database, GameTransaction } from "../database";
import { rooms, roomPlayers, tournaments, tournamentPlayers } from "../schema";
import { validateDisplayName, normalizeDisplayNameKey } from "../display-name";
import { PersistenceError } from "./errors";
import type { TournamentPlayerSeed } from "./tournaments";

/** 控制面 UPDATE 必须恰好命中 1 行：拒绝静默 0 行更新与跨房间误改（docs/03 §7.4）。 */
function assertOneRow(rowCount: number | null, message: string): void {
  if (rowCount !== 1) {
    throw new PersistenceError(message);
  }
}

/**
 * Room 控制面仓储（docs/03-data-model.md §5.1/§5.2/§7.2）。
 *
 * 提供控制面原子写入：Room + 首个 Host 在同一事务提交；Lobby 生命周期
 * （加入/离开/踢人/Host 转移/配置/状态迁移/开局）的原子写操作自 TEX-19 起
 * 也收在本仓储，均复用同一事务边界与既有表，不新建表或迁移。
 */

export type RoomMode = "MULTIPLAYER" | "SINGLE_PLAYER";

/** 创建 Room 与首个 Host 的输入。所有 id 由调用方预生成（幂等重试的前提）。 */
export interface CreateRoomWithHostInput {
  readonly roomId: string;
  readonly mode: RoomMode;
  /** MULTIPLAYER 必填（6 位大写字母/数字、排除易混淆字符）；SINGLE_PLAYER 必须为 null。 */
  readonly inviteCode: string | null;
  readonly configJson: unknown;
  /** 初始状态：默认 CREATED（保持既有契约）；TEX-19 创建流程传 "LOBBY" 使持久化与内存一致。 */
  readonly initialStatus?: "CREATED" | "LOBBY";
  readonly host: {
    readonly playerId: string;
    readonly displayName: string;
    /** HUMAN 的凭证摘要（computePlayerTokenDigest 产物）与密钥版本。 */
    readonly tokenDigest: Buffer;
    readonly tokenKeyId: string;
  };
}

export type RoomStatusDb = "CREATED" | "LOBBY" | "IN_GAME" | "FINISHED" | "CLOSED";
export type LeftReasonDb = "USER_LEFT" | "DISCONNECT_TIMEOUT" | "ROOM_CLOSED";

/** 加入成员（room_players 行）的输入。id 由调用方预生成（幂等重试的前提）。 */
export interface InsertRoomPlayerInput {
  readonly roomId: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly kind: "HUMAN" | "BOT";
  readonly tokenDigest: Buffer;
  readonly tokenKeyId: string;
}

/** 关闭/终态 Room 需要的可选字段（rooms_closed_* CHECK 要求一致出现）。 */
export interface RoomStatusFields {
  readonly closedReason?: string;
  readonly closedAt?: Date;
  readonly retentionExpiresAt?: Date;
}

/** 开局原子写入输入：Tournament + locked players + Room→IN_GAME 单事务。 */
export interface StartTournamentPersistenceInput {
  readonly roomId: string;
  readonly tournamentId: string;
  readonly tournamentNo: number;
  readonly configJson: unknown;
  readonly players: readonly TournamentPlayerSeed[];
}

export interface RoomRepository {
  /**
   * 单事务写入 Room + 首个 Host（§5.1 的三步顺序）：
   * 1. 插入 `rooms`（host_player_id = NULL）；
   * 2. 插入 `room_players`（Host 身份，含 token 摘要）；
   * 3. 回填 `rooms.host_player_id`。
   * DEFERRABLE 复合外键在提交时才检查 Host 属于本 Room。
   */
  createRoomWithHost(input: CreateRoomWithHostInput): Promise<void>;

  /** 加入成员：单事务插入 `room_players`（ACTIVE）。 */
  insertRoomPlayer(input: InsertRoomPlayerInput): Promise<void>;

  /** 状态迁移：更新 `rooms.status` 与可选的关闭元数据（CLOSED 时必须一致出现）。 */
  setRoomStatus(roomId: string, status: RoomStatusDb, fields?: RoomStatusFields): Promise<void>;

  /** 配置变更：更新 `rooms.config_json`。 */
  updateRoomConfig(roomId: string, configJson: unknown): Promise<void>;

  /** Host 转移：更新 `rooms.host_player_id`（可为 NULL）。 */
  setRoomHost(roomId: string, hostPlayerId: string | null): Promise<void>;

  /** 成员离开/被踢：标记 `room_players` 为 LEFT 并记录原因与时间。 */
  markRoomPlayerLeft(roomId: string, playerId: string, reason: LeftReasonDb, leftAt: Date): Promise<void>;

  /**
   * 原子离开：同一事务内标记成员 LEFT 并回填新 Host（避免成员已 LEFT 但 Host 未转移的半提交）。
   * 末位真人离开时传入 `roomClosure`，同一事务把房间置为 CLOSED 并写齐关闭元数据。
   */
  markRoomPlayerLeftAndSetHost(
    roomId: string,
    playerId: string,
    reason: LeftReasonDb,
    leftAt: Date,
    newHostPlayerId: string | null,
    roomClosure?: { readonly reason: string; readonly closedAt: Date; readonly retentionExpiresAt: Date },
  ): Promise<void>;

  /**
   * 开局原子写入：单事务写入 Tournament（IN_GAME、last_committed_sequence=0）、
   * 全部 tournament_players 锁定快照，并把 `rooms.status` 置为 IN_GAME；
   * 任一失败整体回滚，不留半开比赛（docs/03-data-model.md §5.3/§7.2）。
   */
  startTournament(input: StartTournamentPersistenceInput): Promise<void>;
}

export function createRoomRepository(database: Database): RoomRepository {
  async function createRoomWithHost(input: CreateRoomWithHostInput): Promise<void> {
    validateDisplayName(input.host.displayName);
    const displayNameKey = normalizeDisplayNameKey(input.host.displayName);
    await database.withTransaction(async (tx: GameTransaction) => {
      await tx.insert(rooms).values({
        id: input.roomId,
        mode: input.mode,
        inviteCode: input.inviteCode,
        status: input.initialStatus ?? "CREATED",
        configJson: input.configJson,
        hostPlayerId: null,
      });
      await tx.insert(roomPlayers).values({
        id: input.host.playerId,
        roomId: input.roomId,
        displayName: input.host.displayName,
        displayNameKey,
        kind: "HUMAN",
        tokenDigest: input.host.tokenDigest,
        tokenKeyId: input.host.tokenKeyId,
        status: "ACTIVE",
      });
      await tx.update(rooms).set({ hostPlayerId: input.host.playerId }).where(eq(rooms.id, input.roomId));
    });
  }

  async function insertRoomPlayer(input: InsertRoomPlayerInput): Promise<void> {
    validateDisplayName(input.displayName);
    await database.withTransaction(async (tx: GameTransaction) => {
      await tx.insert(roomPlayers).values({
        id: input.playerId,
        roomId: input.roomId,
        displayName: input.displayName,
        displayNameKey: input.displayNameKey,
        kind: input.kind,
        tokenDigest: input.tokenDigest,
        tokenKeyId: input.tokenKeyId,
        status: "ACTIVE",
      });
    });
  }

  async function setRoomStatus(roomId: string, status: RoomStatusDb, fields?: RoomStatusFields): Promise<void> {
    await database.withTransaction(async (tx: GameTransaction) => {
      const result = await tx
        .update(rooms)
        .set({
          status,
          closedReason: fields?.closedReason ?? null,
          closedAt: fields?.closedAt ?? null,
          retentionExpiresAt: fields?.retentionExpiresAt ?? null,
        })
        .where(eq(rooms.id, roomId));
      assertOneRow(result.rowCount, `room ${roomId} not found for status update`);
    });
  }

  async function updateRoomConfig(roomId: string, configJson: unknown): Promise<void> {
    await database.withTransaction(async (tx: GameTransaction) => {
      const result = await tx.update(rooms).set({ configJson }).where(eq(rooms.id, roomId));
      assertOneRow(result.rowCount, `room ${roomId} not found for config update`);
    });
  }

  async function setRoomHost(roomId: string, hostPlayerId: string | null): Promise<void> {
    await database.withTransaction(async (tx: GameTransaction) => {
      const result = await tx.update(rooms).set({ hostPlayerId }).where(eq(rooms.id, roomId));
      assertOneRow(result.rowCount, `room ${roomId} not found for host update`);
    });
  }

  async function markRoomPlayerLeft(
    roomId: string,
    playerId: string,
    reason: LeftReasonDb,
    leftAt: Date,
  ): Promise<void> {
    await database.withTransaction(async (tx: GameTransaction) => {
      const result = await tx
        .update(roomPlayers)
        .set({ status: "LEFT", leftReason: reason, leftAt })
        .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.id, playerId)));
      assertOneRow(result.rowCount, `room player ${playerId} not found in room ${roomId} for leave update`);
    });
  }

  async function markRoomPlayerLeftAndSetHost(
    roomId: string,
    playerId: string,
    reason: LeftReasonDb,
    leftAt: Date,
    newHostPlayerId: string | null,
    roomClosure?: { readonly reason: string; readonly closedAt: Date; readonly retentionExpiresAt: Date },
  ): Promise<void> {
    await database.withTransaction(async (tx: GameTransaction) => {
      const left = await tx
        .update(roomPlayers)
        .set({ status: "LEFT", leftReason: reason, leftAt })
        .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.id, playerId)));
      assertOneRow(left.rowCount, `room player ${playerId} not found in room ${roomId} for leave update`);
      const host = await tx.update(rooms).set({ hostPlayerId: newHostPlayerId }).where(eq(rooms.id, roomId));
      assertOneRow(host.rowCount, `room ${roomId} not found for host transfer`);
      if (roomClosure !== undefined) {
        const closed = await tx
          .update(rooms)
          .set({
            status: "CLOSED",
            closedReason: roomClosure.reason,
            closedAt: roomClosure.closedAt,
            retentionExpiresAt: roomClosure.retentionExpiresAt,
          })
          .where(eq(rooms.id, roomId));
        assertOneRow(closed.rowCount, `room ${roomId} not found for closure`);
      }
    });
  }

  async function startTournament(input: StartTournamentPersistenceInput): Promise<void> {
    if (input.players.length === 0) {
      throw new PersistenceError("startTournament requires at least one player");
    }
    for (const player of input.players) {
      validateDisplayName(player.displayName);
    }
    await database.withTransaction(async (tx: GameTransaction) => {
      await tx.insert(tournaments).values({
        id: input.tournamentId,
        roomId: input.roomId,
        tournamentNo: input.tournamentNo,
        status: "IN_GAME",
        configJson: input.configJson,
        lastCommittedSequence: 0n,
      });
      await tx.insert(tournamentPlayers).values(
        input.players.map((player) => ({
          id: player.id,
          tournamentId: input.tournamentId,
          roomId: input.roomId,
          playerId: player.playerId,
          displayName: player.displayName,
          seatIndex: player.seatIndex,
          kind: player.kind,
          startingStack: player.startingStack,
          pokerStatus: "ACTIVE" as const,
        })),
      );
      await tx.update(rooms).set({ status: "IN_GAME" }).where(eq(rooms.id, input.roomId));
    });
  }

  return {
    createRoomWithHost,
    insertRoomPlayer,
    setRoomStatus,
    updateRoomConfig,
    setRoomHost,
    markRoomPlayerLeft,
    markRoomPlayerLeftAndSetHost,
    startTournament,
  };
}
