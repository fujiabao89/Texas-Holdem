/**
 * Room/Lobby HTTP 入口（docs/04-game-server-architecture.md §10）。
 *
 * 端点：
 *   POST   /api/v1/rooms
 *   POST   /api/v1/rooms/join
 *   PATCH  /api/v1/rooms/{roomId}
 *   POST   /api/v1/rooms/{roomId}/tournaments
 *   POST   /api/v1/rooms/{roomId}/leave
 *
 * 全部外部输入先经 `packages/protocol` 的运行时 Schema 校验；成功返回 `{ data }`，
 * 失败返回 `ErrorEnvelope`。受保护接口解析 `Authorization: Bearer <playerToken>`，
 * 所有状态变更 POST/PATCH 强制 `Idempotency-Key`。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  IdempotencyKeySchema,
  JoinRoomRequestSchema,
  JoinRoomResponseSchema,
  LeaveRoomRequestSchema,
  StartTournamentRequestSchema,
  UpdateRoomRequestSchema,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import { normalizeDisplayNameKey } from "../../infrastructure/persistence/display-name";
import { RoomDomainError } from "../../rooms/room-errors";
import type { RoomManager } from "../../rooms/room-manager";
import { projectRoomSnapshot } from "../../rooms/room-runtime";
import { toErrorResponse } from "../errors";
import { extractBearerToken } from "../middleware/auth";
import { hashPayload, type IdempotencyStore } from "../middleware/idempotency";
import type { RateLimiter } from "../middleware/rate-limit";

export interface RoomRoutesDeps {
  readonly manager: RoomManager;
  readonly rateLimiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  /** 规则权威校验：poker-engine 的 validateTournamentConfig（只调用，不复制规则）。 */
  readonly validateConfig: (config: TournamentConfig) => TournamentConfig;
  /** 受保护路由的 @fastify/rate-limit 配置（CodeQL 识别 config.rateLimit 为路由级限流）。 */
  readonly rateLimit: { readonly max: number; readonly timeWindow: string };
  readonly now: () => number;
  readonly makeTraceId: () => string;
}

type RoomParams = { roomId: string };

function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  if (typeof raw !== "string") return undefined;
  const parsed = IdempotencyKeySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function sendError(reply: FastifyReply, error: unknown, traceId: string): FastifyReply {
  const { statusCode, envelope } = toErrorResponse(error, traceId);
  return reply.status(statusCode).send(envelope);
}

function sendInvalidMessage(reply: FastifyReply, traceId: string): FastifyReply {
  return sendError(reply, new RoomDomainError("INVALID_MESSAGE"), traceId);
}

function sendRateLimited(reply: FastifyReply, traceId: string, retryAfterMs: number): FastifyReply {
  return sendError(reply, new RoomDomainError("RATE_LIMITED", { details: { retryAfterMs } }), traceId);
}

type IdemOutcome = { kind: "replay"; reply: FastifyReply } | { kind: "proceed"; idemKey: string; bodyHash: string };

function checkIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  endpoint: string,
  deps: RoomRoutesDeps,
  traceId: string,
): IdemOutcome {
  const key = idempotencyKeyOf(request);
  if (key === undefined) {
    return { kind: "replay", reply: sendInvalidMessage(reply, traceId) };
  }
  const idemKey = `${scope}:${endpoint}:${key}`;
  const bodyHash = hashPayload(request.body);
  const cached = deps.idempotency.lookup(idemKey);
  if (cached !== undefined) {
    if (cached.payloadHash === bodyHash) {
      return { kind: "replay", reply: reply.status(cached.statusCode).send(cached.body) };
    }
    return {
      kind: "replay",
      reply: sendError(reply, new RoomDomainError("IDEMPOTENCY_KEY_REUSE"), traceId),
    };
  }
  return { kind: "proceed", idemKey, bodyHash };
}

type AuthOutcome = { playerId: string } | { error: FastifyReply };

function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RoomRoutesDeps,
  traceId: string,
): AuthOutcome {
  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    return { error: sendError(reply, new RoomDomainError("AUTH_REQUIRED"), traceId) };
  }
  try {
    return { playerId: deps.manager.authenticate((request.params as RoomParams).roomId, token) };
  } catch (error) {
    return { error: sendError(reply, error, traceId) };
  }
}

export function registerRoomRoutes(app: FastifyInstance, deps: RoomRoutesDeps): void {
  // POST /api/v1/rooms —— 创建房间并加入创建者（创建者即 Host）。
  app.post("/api/v1/rooms", async (request, reply) => {
    const traceId = deps.makeTraceId();
    const rate = deps.rateLimiter.checkCreateRoom(request.ip);
    if (!rate.allowed) return sendRateLimited(reply, traceId, rate.retryAfterMs);
    const idem = checkIdempotency(request, reply, `ip:${request.ip}`, "create", deps, traceId);
    if (idem.kind === "replay") return idem.reply;
    const parsed = CreateRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidMessage(reply, traceId);
    try {
      const config = deps.validateConfig(parsed.data.config);
      const displayNameKey = normalizeDisplayNameKey(parsed.data.displayName);
      const session = await deps.manager.createRoom({
        displayName: parsed.data.displayName,
        displayNameKey,
        config,
      });
      const response = CreateRoomResponseSchema.parse({ data: session });
      deps.idempotency.store(idem.idemKey, { payloadHash: idem.bodyHash, statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (error) {
      return sendError(reply, error, traceId);
    }
  });

  // POST /api/v1/rooms/join —— 以邀请码加入。
  app.post("/api/v1/rooms/join", async (request, reply) => {
    const traceId = deps.makeTraceId();
    const rate = deps.rateLimiter.checkJoinByIp(request.ip);
    if (!rate.allowed) return sendRateLimited(reply, traceId, rate.retryAfterMs);
    const idem = checkIdempotency(request, reply, `ip:${request.ip}`, "join", deps, traceId);
    if (idem.kind === "replay") return idem.reply;
    const parsed = JoinRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidMessage(reply, traceId);
    const inviteRate = deps.rateLimiter.checkJoinByInviteCode(parsed.data.inviteCode);
    if (!inviteRate.allowed) return sendRateLimited(reply, traceId, inviteRate.retryAfterMs);
    try {
      const displayNameKey = normalizeDisplayNameKey(parsed.data.displayName);
      const session = await deps.manager.joinRoom({
        inviteCode: parsed.data.inviteCode,
        displayName: parsed.data.displayName,
        displayNameKey,
      });
      const response = JoinRoomResponseSchema.parse({ data: session });
      deps.idempotency.store(idem.idemKey, { payloadHash: idem.bodyHash, statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (error) {
      return sendError(reply, error, traceId);
    }
  });

  // PATCH /api/v1/rooms/:roomId —— 低频 Lobby 设置（仅 LOBBY；改配置/踢人仅 Host；换座只移动当前身份）。
  app.patch<{ Params: RoomParams }>("/api/v1/rooms/:roomId", { config: { rateLimit: deps.rateLimit } }, async (request, reply) => {
    const traceId = deps.makeTraceId();
    const auth = authenticate(request, reply, deps, traceId);
    if ("error" in auth) return auth.error;
    const rate = deps.rateLimiter.checkProtected(auth.playerId);
    if (!rate.allowed) return sendRateLimited(reply, traceId, rate.retryAfterMs);
    const idem = checkIdempotency(request, reply, `player:${auth.playerId}`, "patch", deps, traceId);
    if (idem.kind === "replay") return idem.reply;
    const parsed = UpdateRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidMessage(reply, traceId);
    const expectedRevision = Number(parsed.data.expectedRoomRevision);
    try {
      let result;
      switch (parsed.data.operation.type) {
        case "UPDATE_CONFIG": {
          const config = deps.validateConfig(parsed.data.operation.config);
          result = await deps.manager.submitCommand(request.params.roomId, {
            type: "UPDATE_CONFIG",
            actorPlayerId: auth.playerId,
            config,
            expectedRevision,
          });
          break;
        }
        case "KICK_PLAYER":
          result = await deps.manager.submitCommand(request.params.roomId, {
            type: "KICK_PLAYER",
            actorPlayerId: auth.playerId,
            targetPlayerId: parsed.data.operation.targetPlayerId,
            expectedRevision,
          });
          break;
        case "CHANGE_SEAT":
          result = await deps.manager.submitCommand(request.params.roomId, {
            type: "CHANGE_SEAT",
            playerId: auth.playerId,
            seat: parsed.data.operation.seat,
            expectedRevision,
          });
          break;
      }
      const response = { data: { roomSnapshot: projectRoomSnapshot(result!.state) } };
      deps.idempotency.store(idem.idemKey, { payloadHash: idem.bodyHash, statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (error) {
      return sendError(reply, error, traceId);
    }
  });

  // POST /api/v1/rooms/:roomId/tournaments —— 开局（仅 Host；LOBBY + 全部入座 + 全部 Ready + revision 精确匹配）。
  app.post<{ Params: RoomParams }>("/api/v1/rooms/:roomId/tournaments", { config: { rateLimit: deps.rateLimit } }, async (request, reply) => {
    const traceId = deps.makeTraceId();
    const auth = authenticate(request, reply, deps, traceId);
    if ("error" in auth) return auth.error;
    const rate = deps.rateLimiter.checkProtected(auth.playerId);
    if (!rate.allowed) return sendRateLimited(reply, traceId, rate.retryAfterMs);
    const idem = checkIdempotency(request, reply, `player:${auth.playerId}`, "start", deps, traceId);
    if (idem.kind === "replay") return idem.reply;
    const parsed = StartTournamentRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidMessage(reply, traceId);
    const expectedRevision = Number(parsed.data.expectedRoomRevision);
    const tournamentId = deps.makeTraceId();
    try {
      const result = await deps.manager.submitCommand(request.params.roomId, {
        type: "START_TOURNAMENT",
        actorPlayerId: auth.playerId,
        expectedRevision,
        tournamentId,
      });
      const response = {
        data: { tournamentId: result.tournamentId, roomSnapshot: projectRoomSnapshot(result.state) },
      };
      deps.idempotency.store(idem.idemKey, { payloadHash: idem.bodyHash, statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (error) {
      return sendError(reply, error, traceId);
    }
  });

  // POST /api/v1/rooms/:roomId/leave —— 主动离开（Host 离开立即转移 Host）。
  app.post<{ Params: RoomParams }>("/api/v1/rooms/:roomId/leave", { config: { rateLimit: deps.rateLimit } }, async (request, reply) => {
    const traceId = deps.makeTraceId();
    const auth = authenticate(request, reply, deps, traceId);
    if ("error" in auth) return auth.error;
    const rate = deps.rateLimiter.checkProtected(auth.playerId);
    if (!rate.allowed) return sendRateLimited(reply, traceId, rate.retryAfterMs);
    const idem = checkIdempotency(request, reply, `player:${auth.playerId}`, "leave", deps, traceId);
    if (idem.kind === "replay") return idem.reply;
    const parsed = LeaveRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendInvalidMessage(reply, traceId);
    try {
      const result = await deps.manager.submitCommand(request.params.roomId, {
        type: "LEAVE",
        playerId: auth.playerId,
        reason: "USER_LEFT",
        leftAt: deps.now(),
      });
      const response = { data: { roomSnapshot: projectRoomSnapshot(result.state) } };
      deps.idempotency.store(idem.idemKey, { payloadHash: idem.bodyHash, statusCode: 200, body: response });
      return reply.status(200).send(response);
    } catch (error) {
      return sendError(reply, error, traceId);
    }
  });
}
