import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { validateTournamentConfig } from "@texas-holdem/poker-engine";
import {
  createProtocolError,
  type ProtocolError,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import type { AppConfig } from "./config";
import type { HandHistoryReadRepository } from "./infrastructure/persistence/repositories/hand-history";
import { registerHandHistoryRoutes } from "./http/routes/hand-history";
import { registerRoomRoutes } from "./http/routes/rooms";
import { registerLobbyGateway, type LobbyGatewayClock } from "./realtime/gateway/lobby-gateway";
import type { ConnectionEpochRegistry } from "./realtime/connection-epochs";
import type { TournamentEventBus } from "./realtime/tournament-event-bus";
import { IdempotencyStore } from "./http/middleware/idempotency";
import { createRateLimiter, type RateLimiter } from "./http/middleware/rate-limit";
import { createNodeIdSource, type IdSource } from "./rooms/id-source";
import type { RoomManager } from "./rooms/room-manager";
import type { TournamentManager } from "./tournaments/tournament-manager";

/** 规则权威校验适配：engine 返回 readonly 冻结配置，复制为协议可变类型（只调用，不复制规则）。 */
function validateRoomConfig(config: TournamentConfig): TournamentConfig {
  const validated = validateTournamentConfig(config);
  return {
    maxPlayers: validated.maxPlayers,
    startingStack: validated.startingStack,
    smallBlind: validated.smallBlind,
    bigBlind: validated.bigBlind,
    blindMode: validated.blindMode,
    blindStructure: [...validated.blindStructure],
    actionTime: validated.actionTime,
    timeBank: validated.timeBank,
  };
}

/** @fastify/rate-limit 超额时抛出的标记对象（{ statusCode: 429, envelope: ProtocolError }）。 */
function isRateLimitEnvelope(error: unknown): error is { statusCode: number; envelope: ProtocolError } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 429 &&
    "envelope" in error
  );
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly roomManager: RoomManager;
  readonly rateLimiter?: RateLimiter;
  readonly idempotency?: IdempotencyStore;
  readonly now?: () => number;
  /** HTTP/WS trace 与 connectionId 的可注入安全随机来源。 */
  readonly ids?: Pick<IdSource, "uuid">;
  /** 仅用于受控的 Gateway 生命周期测试。 */
  readonly lobbyGatewayClock?: LobbyGatewayClock;
  readonly tournamentManager?: TournamentManager;
  readonly tournamentEvents?: TournamentEventBus;
  readonly connectionEpochs?: ConnectionEpochRegistry;
  /** Hand History 投影读取仓储（TEX-36）；生产装配必传，缺省时端点不注册。 */
  readonly handHistoryRepository?: HandHistoryReadRepository;
  /** @fastify/rate-limit 全局 per-IP 额度（CodeQL 识别为 RateLimitingMiddleware）。 */
  readonly rateLimit?: { readonly max: number; readonly timeWindow: string };
}

/**
 * 构建 Fastify 应用实例（不启动监听）。
 * HTTP Request Body 上限 64KiB（docs/04-game-server-architecture.md §10.3）；
 * CORS 使用显式 Allowlist，不使用通配来源。
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 65_536 });
  const ids = options.ids ?? createNodeIdSource();
  const idempotency = options.idempotency ?? new IdempotencyStore();
  // Must be registered before every route so upgrade interception is reliable.
  app.register(websocket);

  // 显式 CORS Allowlist（含 OPTIONS 预检）。
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && options.config.corsAllowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key");
      reply.header("Vary", "Origin");
      if (request.method === "OPTIONS") {
        reply.status(204).send();
        return;
      }
    } else if (typeof origin === "string" && request.method === "OPTIONS") {
      // 非白名单来源的预检：明确拒绝 403（不设置 CORS 头），避免落入 404。
      reply.status(403).send();
      return;
    }
    done();
  });

  // 路由级 per-IP 限流（docs/04 §10.3 受保护变更额度）：@fastify/rate-limit 全局应用，
  // 429 响应保持协议 ErrorEnvelope（失败一律 { error }）。自定义限流器只保留
  // create/join/inviteCode 的规格额度（本插件无法表达 per-inviteCode 桶）。
  const globalRateLimit = options.rateLimit ?? { max: 60, timeWindow: "1 minute" };
  app.register(rateLimit, {
    max: globalRateLimit.max,
    timeWindow: globalRateLimit.timeWindow,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      envelope: createProtocolError("RATE_LIMITED", request.id, {
        retryable: true,
        details: { retryAfterMs: context.ttl },
      }),
    }),
  });

  // @fastify/rate-limit 以 throw 方式上报超额；自定义错误处理器把标记对象转成
  // 纯净的 ErrorEnvelope + 429，其余错误走 Fastify 默认处理。
  const defaultErrorHandler = app.errorHandler;
  app.setErrorHandler((error, request, reply) => {
    if (isRateLimitEnvelope(error)) {
      return reply.status(429).send({ error: error.envelope });
    }
    return defaultErrorHandler.call(app, error, request, reply);
  });

  // /health 有意豁免全局限流（在插件 onRoute 生效前注册）：廉价端点，健康检查不应被限流误伤。
  app.get("/health", async () => {
    return { status: "ok" };
  });

  // 路由必须在限流插件加载之后再注册（onRoute 钩子只在路由注册时触发），
  // 否则全局限流不会应用到这些路由。
  app.after(() => {
    registerRoomRoutes(app, {
      manager: options.roomManager,
      tournaments: options.tournamentManager,
      rateLimiter: options.rateLimiter ?? createRateLimiter(),
      idempotency,
      validateConfig: validateRoomConfig,
      rateLimit: globalRateLimit,
      now: options.now ?? Date.now,
      makeTraceId: ids.uuid,
    });
    if (options.handHistoryRepository !== undefined) {
      registerHandHistoryRoutes(app, {
        repository: options.handHistoryRepository,
        tokenSecret: options.config.token.secret,
        rateLimit: globalRateLimit,
        now: options.now ?? Date.now,
        makeTraceId: ids.uuid,
      });
    }
    registerLobbyGateway(app, options.roomManager, {
      now: options.now ?? Date.now,
      ids,
      idempotency,
      clock: options.lobbyGatewayClock,
      tournaments: options.tournamentManager,
      events: options.tournamentEvents,
      epochs: options.connectionEpochs,
    });
  });

  return app;
}
