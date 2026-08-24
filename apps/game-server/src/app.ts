import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { validateTournamentConfig } from "@texas-holdem/poker-engine";
import {
  createProtocolError,
  type ErrorEnvelope,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import type { AppConfig } from "./config";
import { registerRoomRoutes } from "./http/routes/rooms";
import { IdempotencyStore } from "./http/middleware/idempotency";
import { createRateLimiter, type RateLimiter } from "./http/middleware/rate-limit";
import type { RoomManager } from "./rooms/room-manager";

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

/** @fastify/rate-limit 超额时抛出的标记对象（{ statusCode: 429, envelope }）。 */
function isRateLimitEnvelope(error: unknown): error is { statusCode: number; envelope: ErrorEnvelope } {
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

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // 路由必须在限流插件加载之后再注册（onRoute 钩子只在路由注册时触发），
  // 否则全局限流不会应用到这些路由。
  app.after(() => {
    registerRoomRoutes(app, {
      manager: options.roomManager,
      rateLimiter: options.rateLimiter ?? createRateLimiter(),
      idempotency: options.idempotency ?? new IdempotencyStore(),
      validateConfig: validateRoomConfig,
      rateLimit: globalRateLimit,
      now: options.now ?? Date.now,
      makeTraceId: () => randomUUID(),
    });
  });

  return app;
}
