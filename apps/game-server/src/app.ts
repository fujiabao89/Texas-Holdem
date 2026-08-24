import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { validateTournamentConfig } from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";
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

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly roomManager: RoomManager;
  readonly rateLimiter?: RateLimiter;
  readonly idempotency?: IdempotencyStore;
  readonly now?: () => number;
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

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerRoomRoutes(app, {
    manager: options.roomManager,
    rateLimiter: options.rateLimiter ?? createRateLimiter(),
    idempotency: options.idempotency ?? new IdempotencyStore(),
    validateConfig: validateRoomConfig,
    now: options.now ?? Date.now,
    makeTraceId: () => randomUUID(),
  });

  return app;
}
