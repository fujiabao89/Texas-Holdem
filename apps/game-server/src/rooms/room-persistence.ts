/**
 * Room 控制面持久化适配器（复用 TEX-18 仓储/事务边界）。
 *
 * 领域层（rooms/**）通过本接口把控制面变更落库，不直接接触 drizzle/schema；
 * 实现委托给 `RoomRepository`（含 TEX-19 新增的 Lobby 写方法）与
 * `TournamentStarter`。seat/ready/connectionStatus 等 Lobby 运行态只在内存，
 * 不入库（docs/03-data-model.md §5.2）。
 */

import {
  normalizeDisplayNameKey,
  validateDisplayName,
} from "../infrastructure/persistence/display-name";
import type { RoomRepository } from "../infrastructure/persistence/repositories";
import { RoomDomainError } from "./room-errors";
import type { LeaveReason, RoomStatus } from "./room-runtime";
import type { TournamentStartRequest } from "./tournament-starter";

export interface InsertMemberInput {
  readonly roomId: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly tokenDigest: Buffer;
  readonly tokenKeyId: string;
}

export interface RoomStatusFields {
  readonly closedReason?: string;
  readonly closedAt?: number;
}

export interface RoomPersistence {
  insertMember(input: InsertMemberInput): Promise<void>;
  markMemberLeft(roomId: string, playerId: string, reason: LeaveReason, leftAt: number): Promise<void>;
  updateRoomConfig(roomId: string, config: unknown): Promise<void>;
  setRoomHost(roomId: string, hostPlayerId: string | null): Promise<void>;
  setRoomStatus(roomId: string, status: RoomStatus, fields?: RoomStatusFields): Promise<void>;
  startTournament(request: TournamentStartRequest): Promise<void>;
}

const DB_STATUS: Record<RoomStatus, "LOBBY" | "IN_GAME" | "FINISHED" | "CLOSED"> = {
  LOBBY: "LOBBY",
  IN_GAME: "IN_GAME",
  FINISHED: "FINISHED",
  CLOSED: "CLOSED",
};

const DB_LEFT_REASON: Record<LeaveReason, "USER_LEFT" | "DISCONNECT_TIMEOUT" | "ROOM_CLOSED"> = {
  USER_LEFT: "USER_LEFT",
  DISCONNECT_TIMEOUT: "DISCONNECT_TIMEOUT",
  ROOM_CLOSED: "ROOM_CLOSED",
};

/** 已关闭 Room 的历史保留期：closed_at + 180 天（docs/03-data-model.md §5.10）。 */
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export function createRoomPersistence(deps: {
  readonly roomRepository: RoomRepository;
  readonly startTournament: (request: TournamentStartRequest) => Promise<void>;
}): RoomPersistence {
  return {
    async insertMember(input) {
      validateDisplayName(input.displayName);
      const displayNameKey = normalizeDisplayNameKey(input.displayName);
      try {
        await deps.roomRepository.insertRoomPlayer({
          roomId: input.roomId,
          playerId: input.playerId,
          displayName: input.displayName,
          displayNameKey,
          kind: "HUMAN",
          tokenDigest: input.tokenDigest,
          tokenKeyId: input.tokenKeyId,
        });
      } catch (error) {
        // DB 是昵称唯一性的最终裁决（UNIQUE(room_id, display_name_key)）；串行执行器
        // 已先在内存判重，这里只兜底并发/缓存缺口，禁止静默覆盖。
        if (isUniqueViolation(error)) {
          throw new RoomDomainError("NICKNAME_TAKEN");
        }
        throw error;
      }
    },

    async markMemberLeft(roomId, playerId, reason, leftAt) {
      await deps.roomRepository.markRoomPlayerLeft(
        roomId,
        playerId,
        DB_LEFT_REASON[reason],
        new Date(leftAt),
      );
    },

    async updateRoomConfig(roomId, config) {
      await deps.roomRepository.updateRoomConfig(roomId, config);
    },

    async setRoomHost(roomId, hostPlayerId) {
      await deps.roomRepository.setRoomHost(roomId, hostPlayerId);
    },

    async setRoomStatus(roomId, status, fields) {
      await deps.roomRepository.setRoomStatus(roomId, DB_STATUS[status], {
        closedReason: fields?.closedReason,
        closedAt: fields?.closedAt !== undefined ? new Date(fields.closedAt) : undefined,
        retentionExpiresAt: fields?.closedAt !== undefined ? new Date(fields.closedAt + RETENTION_MS) : undefined,
      });
    },

    async startTournament(request) {
      await deps.startTournament(request);
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return (cause as { code?: string }).code === "23505";
    }
  }
  return false;
}
