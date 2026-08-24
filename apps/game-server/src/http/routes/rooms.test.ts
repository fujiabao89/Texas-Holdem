import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { buildApp } from "../../app";
import { parseAppConfig } from "../../config";
import type { IdSource } from "../../rooms/id-source";
import { createRoomManager, type PlayerSession } from "../../rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "../../rooms/test-support";
import { createRateLimiter } from "../middleware/rate-limit";
import { IdempotencyStore } from "../middleware/idempotency";

const TOKEN_SECRET = "0123456789abcdef0123456789abcdef";

function makeConfig(): TournamentConfig {
  return {
    maxPlayers: 4,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 30,
    timeBank: 60,
  };
}

function makeIds(): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    randomBytes: (count) => Uint8Array.from({ length: count }, () => (n = (n + 1) % 256)),
    now: () => 1000,
  };
}

function makeApp(
  overrides: { now?: () => number; rateLimit?: { max: number; timeWindow: string } } = {},
): FastifyInstance {
  const config = parseAppConfig({ TOKEN_HMAC_SECRET: TOKEN_SECRET });
  const manager = createRoomManager({
    persistence: fakePersistence(),
    roomRepository: fakeRoomRepository(),
    ids: makeIds(),
    tokenSecret: TOKEN_SECRET,
    tokenKeyId: "k1",
  });
  return buildApp({
    config,
    roomManager: manager,
    rateLimiter: createRateLimiter(overrides.now ?? (() => 1000)),
    idempotency: new IdempotencyStore(),
    now: overrides.now ?? (() => 1000),
    rateLimit: overrides.rateLimit,
  });
}

const key = () => randomUUID();

async function createRoom(app: FastifyInstance, ip = "127.0.0.1"): Promise<PlayerSession> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/rooms",
    headers: { "idempotency-key": key() },
    remoteAddress: ip,
    payload: { displayName: "Host", config: makeConfig() },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as PlayerSession;
}

async function joinRoom(app: FastifyInstance, inviteCode: string, displayName: string, ip: string): Promise<PlayerSession> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/rooms/join",
    headers: { "idempotency-key": key() },
    remoteAddress: ip,
    payload: { inviteCode, displayName },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as PlayerSession;
}

function authHeaders(token: string, idempotencyKey = key()): Record<string, string> {
  return { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey };
}

describe("POST /api/v1/rooms", () => {
  it("创建成功：返回 roomId/playerId/playerToken 与 LOBBY 快照，快照不含 Token", async () => {
    const app = makeApp();
    const session = await createRoom(app);
    expect(session.roomSnapshot.status).toBe("LOBBY");
    expect(session.roomSnapshot.hostPlayerId).toBe(session.playerId);
    expect(session.roomSnapshot.inviteCode).toMatch(/^[A-HJKMNPQRSTUVWXYZ2-9]{6}$/);
    expect(JSON.stringify(session.roomSnapshot)).not.toContain("token");
  });

  it("非法 body 返回 400 INVALID_MESSAGE", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "idempotency-key": key() },
      payload: { displayName: "x" }, // 缺 config
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_MESSAGE");
  });

  it("并发同 key 创建只产生一个房间（幂等 in-flight 串行，两者返回相同结果）", async () => {
    const app = makeApp();
    const idemKey = key();
    const payload = { displayName: "Host", config: makeConfig() };
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/rooms", headers: { "idempotency-key": idemKey }, payload }),
      app.inject({ method: "POST", url: "/api/v1/rooms", headers: { "idempotency-key": idemKey }, payload }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // 同一 key 只产生一个房间：两次响应（含 roomId）完全一致
    expect(second.body).toBe(first.body);
  });

  it("相同 Idempotency-Key + 相同 Payload 重试返回原结果；不同 Payload 返回 IDEMPOTENCY_KEY_REUSE", async () => {
    const app = makeApp();
    const idemKey = key();
    const payload = { displayName: "Host", config: makeConfig() };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "idempotency-key": idemKey },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "idempotency-key": idemKey },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "idempotency-key": idemKey },
      payload: { displayName: "Other", config: makeConfig() },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("创建限流：同一 IP 超过 5/min 返回 429 RATE_LIMITED", async () => {
    const app = makeApp({ now: () => 0 });
    for (let i = 0; i < 5; i += 1) {
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/rooms",
        headers: { "idempotency-key": key() },
        remoteAddress: "9.9.9.9",
        payload: { displayName: `P${i}`, config: makeConfig() },
      });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "idempotency-key": key() },
      remoteAddress: "9.9.9.9",
      payload: { displayName: "Last", config: makeConfig() },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });
});

describe("POST /api/v1/rooms/join", () => {
  it("加入成功返回新身份；无效邀请码返回 404 INVALID_INVITE_CODE", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const alice = await joinRoom(app, host.roomSnapshot.inviteCode!, "Alice", "10.0.0.2");
    expect(alice.roomSnapshot.players).toHaveLength(2);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/join",
      headers: { "idempotency-key": key() },
      remoteAddress: "10.0.0.3",
      payload: { inviteCode: "ZZZZZZ", displayName: "Bob" },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe("INVALID_INVITE_CODE");
  });

  it("昵称折叠冲突返回 409 NICKNAME_TAKEN", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    await joinRoom(app, host.roomSnapshot.inviteCode!, "Alice", "10.0.0.2");
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/join",
      headers: { "idempotency-key": key() },
      remoteAddress: "10.0.0.3",
      payload: { inviteCode: host.roomSnapshot.inviteCode, displayName: "ＡＬＩＣＥ" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("NICKNAME_TAKEN");
  });
});

describe("PATCH /api/v1/rooms/:roomId", () => {
  it("换座仅能移动当前身份；过期 revision 返回 409 STALE_ROOM_STATE", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const change = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: authHeaders(host.playerToken),
      payload: { expectedRoomRevision: host.roomSnapshot.roomRevision, operation: { type: "CHANGE_SEAT", seat: 0 } },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().data.roomSnapshot.players[0]?.seat).toBe(0);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: authHeaders(host.playerToken),
      payload: { expectedRoomRevision: host.roomSnapshot.roomRevision, operation: { type: "CHANGE_SEAT", seat: 1 } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_ROOM_STATE");
  });

  it("缺失 Bearer 返回 401 AUTH_REQUIRED；错误 Token 返回 401 AUTH_FAILED", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: { "idempotency-key": key() },
      payload: { expectedRoomRevision: host.roomSnapshot.roomRevision, operation: { type: "CHANGE_SEAT", seat: 0 } },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("AUTH_REQUIRED");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: authHeaders("wrong-token"),
      payload: { expectedRoomRevision: host.roomSnapshot.roomRevision, operation: { type: "CHANGE_SEAT", seat: 0 } },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("AUTH_FAILED");
  });

  it("路由级 IP 限流（@fastify/rate-limit）：同一 IP 连续请求超额度后返回 429 RATE_LIMITED（ErrorEnvelope）", async () => {
    const app = makeApp({ now: () => 0, rateLimit: { max: 3, timeWindow: "1 minute" } });
    // 创建从 10.0.0.1，鉴权尝试从 11.0.0.1（独立 IP 桶，避免创建计数干扰）
    const host = await createRoom(app, "10.0.0.1");
    const attempt = (idemKey: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/rooms/${host.roomId}`,
        headers: { "idempotency-key": idemKey, authorization: "Bearer wrong-token" },
        remoteAddress: "11.0.0.1",
        payload: { expectedRoomRevision: host.roomSnapshot.roomRevision, operation: { type: "CHANGE_SEAT", seat: 0 } },
      });
    for (let i = 0; i < 3; i += 1) {
      const res = await attempt(key());
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("AUTH_FAILED");
    }
    const blocked = await attempt(key());
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(blocked.json().error.retryable).toBe(true);
    expect(blocked.json().error.details?.retryAfterMs).toBeTypeOf("number");
  });

  it("改配置仅 Host：非 Host 返回 403 NOT_HOST", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const alice = await joinRoom(app, host.roomSnapshot.inviteCode!, "Alice", "10.0.0.2");
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: authHeaders(alice.playerToken),
      payload: { expectedRoomRevision: alice.roomSnapshot.roomRevision, operation: { type: "UPDATE_CONFIG", config: makeConfig() } },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe("NOT_HOST");
  });
});

describe("POST /api/v1/rooms/:roomId/tournaments", () => {
  // 说明：SET_READY 是 WS 命令（TEX-21），HTTP 层无 Ready 入口，因此 HTTP 路由只能验证
  // 开局拒绝路径；"全部 Ready 后成功开局" 由 room-executor.test.ts（直接投递命令）覆盖。
  it("未满足开局条件返回 409 INVALID_ACTION", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${host.roomId}/tournaments`,
      headers: authHeaders(host.playerToken),
      payload: { expectedRoomRevision: host.roomSnapshot.roomRevision },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("INVALID_ACTION");
  });

  it("非 Host 返回 403 NOT_HOST", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const alice = await joinRoom(app, host.roomSnapshot.inviteCode!, "Alice", "10.0.0.2");
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${host.roomId}/tournaments`,
      headers: authHeaders(alice.playerToken),
      payload: { expectedRoomRevision: alice.roomSnapshot.roomRevision },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("NOT_HOST");
  });
});

describe("POST /api/v1/rooms/:roomId/leave", () => {
  it("主动离开返回更新后的快照（不含离开者）", async () => {
    const app = makeApp();
    const host = await createRoom(app, "10.0.0.1");
    const leave = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${host.roomId}/leave`,
      headers: authHeaders(host.playerToken),
      payload: {},
    });
    expect(leave.statusCode).toBe(200);
    const snapshot = leave.json().data.roomSnapshot;
    expect(snapshot.players.some((p: { playerId: string }) => p.playerId === host.playerId)).toBe(false);
  });
});
