/**
 * Room/Lobby 集合管理（docs/04-game-server-architecture.md §4/§5）。
 *
 * - 持有全部活跃 Room 运行时、邀请码→roomId 路由与唯一串行执行器；
 *   HTTP/WS 入口只能经 `submitCommand` 投递命令，不得直接 mutate Room。
 * - 创建/加入：创建者自动成为 Host；签发 256-bit playerToken（仅本响应返回），
 *   持久化只存 HMAC 摘要；邀请码只定位 Room、不是身份凭证。
 * - 鉴权：服务端由 token 摘要反查 playerId，不信任请求携带的身份；
 *   对 Room 内每个真人计算 HMAC 并常数时间比较（Room 最多 10 人，代价有界）。
 */

import {
  computePlayerTokenDigest,
  playerTokenDigestsEqual,
} from "../infrastructure/persistence/player-token";
import type { RoomRepository } from "../infrastructure/persistence/repositories";
import type { TournamentConfig, RoomSnapshot } from "@texas-holdem/protocol";
import type { IdSource } from "./id-source";
import { generateUniqueInviteCode } from "./invite-code";
import { generatePlayerToken } from "./player-token";
import { RoomDomainError } from "./room-errors";
import { RoomRuntime, type RoomCommand, type RoomCommandResult } from "./room-executor";
import type { RoomPersistence } from "./room-persistence";
import { createRoomState, projectRoomSnapshot } from "./room-runtime";

export interface RoomManagerDeps {
  readonly persistence: RoomPersistence;
  readonly roomRepository: RoomRepository;
  readonly ids: IdSource;
  /** token HMAC 密钥与版本（docs/03-data-model.md §5.2）：只存服务端环境注入。 */
  readonly tokenSecret: string;
  readonly tokenKeyId: string;
}

export interface PlayerSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly playerToken: string;
  readonly roomSnapshot: RoomSnapshot;
}

export type RoomSnapshotListener = (snapshot: RoomSnapshot) => void;

export interface RoomManager {
  createRoom(input: {
    readonly displayName: string;
    readonly displayNameKey: string;
    readonly config: TournamentConfig;
  }): Promise<PlayerSession>;
  joinRoom(input: {
    readonly inviteCode: string;
    readonly displayName: string;
    readonly displayNameKey: string;
  }): Promise<PlayerSession>;
  submitCommand(roomId: string, command: RoomCommand): Promise<RoomCommandResult>;
  /** 可注入的 Host 转移入口（TEX-21 Host Grace Timer 到期时调用）。 */
  transferHost(roomId: string): Promise<RoomCommandResult>;
  findRoom(roomId: string): RoomRuntime | undefined;
  getSnapshot(roomId: string): RoomSnapshot | undefined;
  subscribe(listener: RoomSnapshotListener): () => void;
  /** 由 token 摘要反查 playerId（常数时间比较每个候选真人）。 */
  authenticate(roomId: string, token: string): string;
}

export function createRoomManager(deps: RoomManagerDeps): RoomManager {
  const rooms = new Map<string, RoomRuntime>();
  const inviteByCode = new Map<string, string>();
  const listeners = new Set<RoomSnapshotListener>();

  function publish(snapshot: RoomSnapshot): void {
    for (const listener of listeners) listener(snapshot);
  }

  function makeToken(roomId: string, playerId: string): { token: string; digest: Buffer } {
    const token = generatePlayerToken(deps.ids.randomBytes);
    const digest = computePlayerTokenDigest({
      roomId,
      playerId,
      token,
      keyId: deps.tokenKeyId,
      secret: deps.tokenSecret,
    });
    return { token, digest };
  }

  return {
    async createRoom(input) {
      const roomId = deps.ids.uuid();
      const playerId = deps.ids.uuid();
      const inviteCode = generateUniqueInviteCode(deps.ids.randomBytes, (code) => inviteByCode.has(code));
      const { token, digest } = makeToken(roomId, playerId);
      await deps.roomRepository.createRoomWithHost({
        roomId,
        mode: "MULTIPLAYER",
        inviteCode,
        configJson: input.config,
        initialStatus: "LOBBY",
        host: { playerId, displayName: input.displayName, tokenDigest: digest, tokenKeyId: deps.tokenKeyId },
      });
      const state = createRoomState({
        roomId,
        inviteCode,
        host: {
          playerId,
          displayName: input.displayName,
          displayNameKey: input.displayNameKey,
          joinedAt: deps.ids.now(),
          tokenDigest: digest,
          tokenKeyId: deps.tokenKeyId,
        },
        config: input.config,
      });
      const runtime = new RoomRuntime(state, { persistence: deps.persistence, ids: deps.ids });
      rooms.set(roomId, runtime);
      inviteByCode.set(inviteCode, roomId);
      const roomSnapshot = projectRoomSnapshot(state);
      publish(roomSnapshot);
      return { roomId, playerId, playerToken: token, roomSnapshot };
    },

    async joinRoom(input) {
      const roomId = inviteByCode.get(input.inviteCode);
      if (roomId === undefined) {
        throw new RoomDomainError("INVALID_INVITE_CODE");
      }
      const runtime = rooms.get(roomId);
      if (runtime === undefined) {
        throw new RoomDomainError("INVALID_INVITE_CODE");
      }
      const playerId = deps.ids.uuid();
      const { token, digest } = makeToken(roomId, playerId);
      const result = await runtime.submit({
        type: "JOIN",
        member: {
          playerId,
          displayName: input.displayName,
          displayNameKey: input.displayNameKey,
          joinedAt: deps.ids.now(),
          tokenDigest: digest,
          tokenKeyId: deps.tokenKeyId,
        },
      });
      const roomSnapshot = projectRoomSnapshot(result.state);
      publish(roomSnapshot);
      return {
        roomId,
        playerId,
        playerToken: token,
        roomSnapshot,
      };
    },

    async submitCommand(roomId, command) {
      const runtime = rooms.get(roomId);
      if (runtime === undefined) {
        throw new RoomDomainError("ROOM_NOT_FOUND");
      }
      const result = await runtime.submit(command);
      publish(projectRoomSnapshot(result.state));
      return result;
    },

    async transferHost(roomId) {
      const runtime = rooms.get(roomId);
      if (runtime === undefined) {
        throw new RoomDomainError("ROOM_NOT_FOUND");
      }
      const result = await runtime.submit({ type: "TRANSFER_HOST" });
      publish(projectRoomSnapshot(result.state));
      return result;
    },

    findRoom(roomId) {
      return rooms.get(roomId);
    },

    getSnapshot(roomId) {
      const runtime = rooms.get(roomId);
      return runtime === undefined ? undefined : projectRoomSnapshot(runtime.current);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    authenticate(roomId, token) {
      const runtime = rooms.get(roomId);
      if (runtime === undefined) {
        throw new RoomDomainError("ROOM_NOT_FOUND");
      }
      for (const member of runtime.current.members.values()) {
        if (member.kind !== "HUMAN" || member.tokenDigest === null || member.tokenKeyId === null) continue;
        const digest = computePlayerTokenDigest({
          roomId,
          playerId: member.playerId,
          token,
          keyId: member.tokenKeyId,
          secret: deps.tokenSecret,
        });
        if (playerTokenDigestsEqual(digest, member.tokenDigest)) {
          return member.playerId;
        }
      }
      throw new RoomDomainError("AUTH_FAILED");
    },
  };
}
