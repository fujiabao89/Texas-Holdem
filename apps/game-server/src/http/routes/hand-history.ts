/**
 * Hand History 投影读取 HTTP 入口（docs/02-protocol-spec.md §4.2；docs/05 §13；TEX-36）。
 *
 * 端点：
 *   GET /api/v1/tournaments/:tournamentId/hands?cursor&limit=20
 *   GET /api/v1/tournaments/:tournamentId/hands/:handId
 *
 * 鉴权：`Authorization: Bearer <playerToken>`。playerId 由服务端经
 * `room_players.token_digest`（HMAC，常数时间比较）反查，不信任请求身份；
 * 读取不依赖内存 RoomManager；房间关闭或成员离开后凭证失效。
 * Token 不进入 URL、查询参数或日志。
 *
 * 隐私红线（docs/02 §6.3；docs/03 §6/§9）：`hand_events.payload` 是含 Burn 牌面
 * 与全部底牌的 Engine 原始事件，本入口逐条经 `state-projector` 的
 * `projectWireEvent` 投影——`DEAL_HOLE_CARD.card` 仅目标玩家可见、`BURN_CARD`
 * 永无牌面、`PLAYER_REVEALED` 牌型只在 Showdown 公开牌上计算；内部 ID
 * （tournamentPlayerId 等）不出现，`seatIndex` 经锁定参赛者映射转为 playerId。
 *
 * 损坏记录（docs/02 §4.2）：事件无法投影或响应无法通过协议 Schema 校验时
 * 返回 500 `INTERNAL_ERROR`，不泄露细节。`hands` 行只在手末原子提交事务内
 * 插入，列表天然只包含已提交的 Hand。
 *
 * 404 语义：Tournament 不存在与 hand 不属于该 Tournament 均返回 404；协议
 * ErrorCode 无 `TOURNAMENT_NOT_FOUND`/`HAND_NOT_FOUND` 专用码；此处不新增错误码，
 * 复用稳定码 `ROOM_NOT_FOUND`（客户端按 `error.code`
 * 分支，传输类别仍为 404）。
 *
 * patch 语义：历史详情每条事件为 schema 合法的 `GameEventMessage`，其
 * `patch` 为空 no-op（`applyPlayerViewPatch(prev, {}) === prev` 恒成立）。
 * 逐事件真实 `PlayerViewPatch` 重建需要 Engine 事件重放（Replay 属后续
 * 方向，docs/03 §11）；Hand History 客户端（docs/05 §13）只消费 `event`
 * 构建时间线，不应用 patch。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  HandHistoryDetailResponseSchema,
  HandHistoryListResponseSchema,
  PROTOCOL_VERSION,
  GameEventMessageSchema,
} from "@texas-holdem/protocol";
import type { Card, PokerEvent } from "@texas-holdem/poker-engine";
import {
  computePlayerTokenDigest,
  playerTokenDigestsEqual,
} from "../../infrastructure/persistence/player-token";
import type {
  HandHistoryHandRecord,
  HandHistoryReadRepository,
  RoomMemberCredentialRecord,
  TournamentParticipantRecord,
} from "../../infrastructure/persistence/repositories/hand-history";
import { projectWireEvent, wireCard } from "../../projection/state-projector";
import { RoomDomainError } from "../../rooms/room-errors";
import { toErrorResponse } from "../errors";
import { extractBearerToken } from "../middleware/auth";

export interface HandHistoryRoutesDeps {
  readonly repository: HandHistoryReadRepository;
  /** 与 RoomManager 同源的 token HMAC 密钥（config.token.secret）。 */
  readonly tokenSecret: string;
  /** @fastify/rate-limit 路由级配置（CodeQL 识别 config.rateLimit 为路由级限流）。 */
  readonly rateLimit: { readonly max: number; readonly timeWindow: string };
  readonly now: () => number;
  readonly makeTraceId: () => string;
}

type TournamentParams = { tournamentId: string };
type HandParams = TournamentParams & { handId: string };

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;
/** 列表 cursor 前缀：防止把其他端点的 opaque cursor 误喂本端点。 */
const CURSOR_PREFIX = "hands";

/** 损坏记录（无法投影/无法通过 Schema 校验）→ 统一 500 INTERNAL_ERROR（docs/02 §4.2）。 */
class CorruptHandRecordError extends Error {
  constructor(detail: string) {
    super(`corrupt hand history record: ${detail}`);
    this.name = "CorruptHandRecordError";
  }
}

/** 列表分页 cursor（opaque）：base64url(`hands:<handNumber>`)，排他下界。 */
export function encodeListCursor(beforeHandNumber: number): string {
  return Buffer.from(`${CURSOR_PREFIX}:${beforeHandNumber}`, "utf8").toString("base64url");
}

/** 解析失败返回 null（调用方回 400 INVALID_MESSAGE）；不区分成因，防枚举探测。 */
export function decodeListCursor(cursor: string): number | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!decoded.startsWith(`${CURSOR_PREFIX}:`)) return null;
  const raw = decoded.slice(CURSOR_PREFIX.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function sendError(reply: FastifyReply, error: unknown, traceId: string): FastifyReply {
  const { statusCode, envelope } = toErrorResponse(error, traceId);
  return reply.status(statusCode).send(envelope);
}

function sendInvalidMessage(reply: FastifyReply, traceId: string): FastifyReply {
  return sendError(reply, new RoomDomainError("INVALID_MESSAGE"), traceId);
}

/** Engine Card 数组校验（`hands.community_cards` / 事件牌面来源不可信时防御性校验）。 */
function parseEngineCards(value: unknown, field: string): readonly Card[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new CorruptHandRecordError(`${field} must be an array of at most 5 engine cards`);
  }
  return value.map((card) => {
    if (
      typeof card !== "object" ||
      card === null ||
      typeof (card as { rank?: unknown }).rank !== "number" ||
      !Number.isInteger((card as { rank: number }).rank) ||
      (card as { rank: number }).rank < 2 ||
      (card as { rank: number }).rank > 14 ||
      typeof (card as { suit?: unknown }).suit !== "string" ||
      !["spades", "hearts", "diamonds", "clubs"].includes((card as { suit: string }).suit)
    ) {
      throw new CorruptHandRecordError(`${field} contains a malformed engine card`);
    }
    return card as Card;
  });
}

/** 单一查询参数（重复参数按非法处理）。 */
function singleQueryParam(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined || typeof value === "string") return value;
  throw new RoomDomainError("INVALID_MESSAGE");
}

interface AuthorizedViewer {
  readonly playerId: string;
  readonly participants: readonly TournamentParticipantRecord[];
}

/**
 * Bearer token → viewer：Tournament → Room → `room_players.token_digest` 常数时间
 * 匹配（与 RoomManager.authenticate 同一 HMAC 语义），再校验 viewer 是该
 * Tournament 锁定参赛者（否则 FORBIDDEN）。错误直接写入 reply 并返回 null。
 */
async function authorizeViewer(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HandHistoryRoutesDeps,
  tournamentId: string,
  traceId: string,
): Promise<AuthorizedViewer | null> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    sendError(reply, new RoomDomainError("AUTH_REQUIRED"), traceId);
    return null;
  }
  const tournament = await deps.repository.findTournamentRoom(tournamentId);
  if (tournament === null) {
    // Tournament 不存在 → 404（复用 ROOM_NOT_FOUND 稳定码，见文件头说明）。
    sendError(reply, new RoomDomainError("ROOM_NOT_FOUND"), traceId);
    return null;
  }
  const members = await deps.repository.listRoomMemberCredentials(tournament.roomId);
  const playerId = resolveViewerByToken(members, tournament.roomId, token, deps.tokenSecret);
  if (playerId === null) {
    sendError(reply, new RoomDomainError("AUTH_FAILED"), traceId);
    return null;
  }
  const participants = await deps.repository.listParticipants(tournamentId);
  if (!participants.some((participant) => participant.playerId === playerId)) {
    sendError(reply, new RoomDomainError("FORBIDDEN"), traceId);
    return null;
  }
  return { playerId, participants };
}

/** 对仓储筛选出的有效成员逐候选常数时间比较（BOT 无凭证跳过）。 */
function resolveViewerByToken(
  members: readonly RoomMemberCredentialRecord[],
  roomId: string,
  token: string,
  secret: string,
): string | null {
  for (const member of members) {
    if (member.kind !== "HUMAN" || member.tokenDigest === null || member.tokenKeyId === null) {
      continue;
    }
    const digest = computePlayerTokenDigest({
      roomId,
      playerId: member.playerId,
      token,
      keyId: member.tokenKeyId,
      secret,
    });
    if (playerTokenDigestsEqual(digest, member.tokenDigest)) {
      return member.playerId;
    }
  }
  return null;
}

/** 列表项构建（HandHistoryItem 字段全来自 `hands` 公开列 + `summary` 投影）。 */
function buildListItem(
  hand: HandHistoryHandRecord,
  seatToPlayer: ReadonlyMap<number, string>,
): {
  handId: string;
  handNumber: number;
  startedAt: number;
  endedAt: number;
  smallBlind: number;
  bigBlind: number;
  communityCards: ReturnType<typeof wireCard>[];
  endReason: string;
  potTotal: number;
  winnerPlayerIds: string[];
} {
  const summary = hand.summary;
  const pots = readSummaryPots(summary);
  const winnerSeats = readSummaryWinnerSeats(summary);
  const winnerPlayerIds = winnerSeats.map((seat) => {
    const playerId = seatToPlayer.get(seat);
    if (playerId === undefined) {
      throw new CorruptHandRecordError(`summary winner seat ${seat} has no locked participant`);
    }
    return playerId;
  });
  if (winnerPlayerIds.length === 0) {
    throw new CorruptHandRecordError("summary has no winners");
  }
  return {
    handId: hand.id,
    handNumber: hand.handNumber,
    startedAt: hand.startedAt.getTime(),
    endedAt: hand.endedAt.getTime(),
    smallBlind: toSafeInteger(hand.smallBlind, "smallBlind"),
    bigBlind: toSafeInteger(hand.bigBlind, "bigBlind"),
    communityCards: parseEngineCards(hand.communityCards, "communityCards").map(wireCard),
    endReason: hand.endReason,
    potTotal: pots.reduce((sum, pot) => sum + pot, 0),
    winnerPlayerIds,
  };
}

function readSummaryPots(summary: unknown): number[] {
  if (typeof summary !== "object" || summary === null || !Array.isArray((summary as { pots?: unknown }).pots)) {
    throw new CorruptHandRecordError("summary.pots must be an array");
  }
  return (summary as { pots: unknown[] }).pots.map((pot) => {
    if (typeof pot !== "object" || pot === null || typeof (pot as { amount?: unknown }).amount !== "number") {
      throw new CorruptHandRecordError("summary.pots entry must carry a numeric amount");
    }
    return (pot as { amount: number }).amount;
  });
}

function readSummaryWinnerSeats(summary: unknown): number[] {
  if (typeof summary !== "object" || summary === null || !Array.isArray((summary as { winners?: unknown }).winners)) {
    throw new CorruptHandRecordError("summary.winners must be an array of seat indexes");
  }
  return (summary as { winners: unknown[] }).winners.map((seat) => {
    if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 0 || seat > 9) {
      throw new CorruptHandRecordError("summary.winners must contain seat indexes");
    }
    return seat;
  });
}

function toSafeInteger(value: bigint, field: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new CorruptHandRecordError(`${field} is out of safe integer range`);
  }
  return converted;
}

export function registerHandHistoryRoutes(app: FastifyInstance, deps: HandHistoryRoutesDeps): void {
  // GET /api/v1/tournaments/:tournamentId/hands —— 归档手牌列表（handNumber DESC cursor 分页）。
  app.get<{ Params: TournamentParams }>(
    "/api/v1/tournaments/:tournamentId/hands",
    { config: { rateLimit: deps.rateLimit } },
    async (request, reply) => {
      const traceId = deps.makeTraceId();
      try {
        const auth = await authorizeViewer(request, reply, deps, request.params.tournamentId, traceId);
        if (auth === null) return reply;

        const query = request.query as Record<string, unknown>;
        const limitRaw = singleQueryParam(query, "limit");
        let limit = DEFAULT_LIST_LIMIT;
        if (limitRaw !== undefined) {
          if (!/^(0|[1-9][0-9]*)$/.test(limitRaw)) return sendInvalidMessage(reply, traceId);
          limit = Number(limitRaw);
          if (limit < 1 || limit > MAX_LIST_LIMIT) return sendInvalidMessage(reply, traceId);
        }
        const cursorRaw = singleQueryParam(query, "cursor");
        let beforeHandNumber: number | null = null;
        if (cursorRaw !== undefined) {
          beforeHandNumber = decodeListCursor(cursorRaw);
          if (beforeHandNumber === null) return sendInvalidMessage(reply, traceId);
        }

        const seatToPlayer = new Map(
          auth.participants.map((participant) => [participant.seatIndex, participant.playerId] as const),
        );
        // 多取 1 行探测下一页，避免额外 count 查询。
        const rows = await deps.repository.listHands(
          request.params.tournamentId,
          beforeHandNumber,
          limit + 1,
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map((hand) => buildListItem(hand, seatToPlayer));
        const nextCursor = hasMore ? encodeListCursor(page[page.length - 1].handNumber) : null;
        return reply.status(200).send(
          HandHistoryListResponseSchema.parse({
            data: { tournamentId: request.params.tournamentId, items, nextCursor },
          }),
        );
      } catch (error) {
        return sendError(reply, error, traceId);
      }
    },
  );

  // GET /api/v1/tournaments/:tournamentId/hands/:handId —— 接收者视角投影的整手事件。
  app.get<{ Params: HandParams }>(
    "/api/v1/tournaments/:tournamentId/hands/:handId",
    { config: { rateLimit: deps.rateLimit } },
    async (request, reply) => {
      const traceId = deps.makeTraceId();
      try {
        const { tournamentId, handId } = request.params;
        const auth = await authorizeViewer(request, reply, deps, tournamentId, traceId);
        if (auth === null) return reply;

        const hand = await deps.repository.findHand(tournamentId, handId);
        if (hand === null) {
          // hand 不存在或不属于该 Tournament → 404（复用 ROOM_NOT_FOUND 稳定码）。
          return sendError(reply, new RoomDomainError("ROOM_NOT_FOUND"), traceId);
        }
        const events = await deps.repository.listHandEvents(tournamentId, handId);
        if (events.length === 0) {
          throw new CorruptHandRecordError("committed hand has no events");
        }
        for (let index = 0; index < events.length; index++) {
          if (events[index].handSequence !== index + 1 ||
            (index > 0 && events[index].sequence !== events[index - 1].sequence + 1n)) {
            throw new CorruptHandRecordError("event sequence gap");
          }
        }
        if (events[events.length - 1].sequence !== hand.endSequence) {
          throw new CorruptHandRecordError("events do not reach the committed snapshot");
        }
        const handStartIndex = events.findIndex((event) => event.type === "HAND_STARTED");
        if (handStartIndex < 0) throw new CorruptHandRecordError("missing hand start");

        const seatToPlayer = new Map(
          auth.participants.map((participant) => [participant.seatIndex, participant.playerId] as const),
        );
        const board = parseEngineCards(hand.communityCards, "communityCards");
        const serverTime = deps.now();
        const projectedEvents = events.map((event, index) => {
          const engineEvent = { ...(event.payload as object), type: event.type } as PokerEvent;
          const wireEvent = projectWireEvent(engineEvent, {
            seatToPlayer,
            viewerPlayerId: auth.playerId,
            blindLevelIndex: hand.blindLevelIndex,
            board,
          });
          const message = {
            type: "GAME_EVENT" as const,
            protocolVersion: PROTOCOL_VERSION,
            serverTime,
            payload: {
              tournamentId,
              sequence: event.sequence.toString(),
              handId: index < handStartIndex ? null : handId,
              event: wireEvent,
              patch: {},
            },
          };
          // 逐条 Schema 校验：无法解析/投影 → 损坏记录 → 500（不泄露细节）。
          return GameEventMessageSchema.parse(message);
        });

        const startSequence = events[0].sequence.toString();
        const endSequence = events[events.length - 1].sequence.toString();
        return reply.status(200).send(
          HandHistoryDetailResponseSchema.parse({
            data: { tournamentId, handId, startSequence, endSequence, events: projectedEvents },
          }),
        );
      } catch (error) {
        return sendError(reply, error, traceId);
      }
    },
  );
}
