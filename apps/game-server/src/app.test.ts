import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { parseAppConfig, resolveTokenSecret } from "./config";
import { createNodeIdSource } from "./rooms/id-source";
import { createRoomManager } from "./rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "./rooms/test-support";

function makeApp() {
  const config = parseAppConfig({ TOKEN_HMAC_SECRET: "0123456789abcdef0123456789abcdef" });
  const manager = createRoomManager({
    persistence: fakePersistence(),
    roomRepository: fakeRoomRepository(),
    ids: createNodeIdSource(),
    tokenSecret: config.token.secret,
    tokenKeyId: config.token.keyId,
  });
  return buildApp({ config, roomManager: manager });
}

describe("buildApp", () => {
  it("解析当前签发 key 与保留期旧验证 key，并拒绝重复定义当前 key", () => {
    const config = parseAppConfig({ TOKEN_HMAC_SECRET: "c".repeat(32), TOKEN_HMAC_KEY_ID: "v2", TOKEN_HMAC_RETAINED_KEYS: JSON.stringify({ v1: "p".repeat(32) }) });
    expect(resolveTokenSecret(config, "v2")).toBe("c".repeat(32));
    expect(resolveTokenSecret(config, "v1")).toBe("p".repeat(32));
    expect(resolveTokenSecret(config, "unknown")).toBeUndefined();
    expect(() => parseAppConfig({ TOKEN_HMAC_SECRET: "c".repeat(32), TOKEN_HMAC_KEY_ID: "v2", TOKEN_HMAC_RETAINED_KEYS: JSON.stringify({ v2: "p".repeat(32) }) })).toThrow("must not redefine TOKEN_HMAC_KEY_ID");
  });

  it("responds to /health", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("未携带 Idempotency-Key 的创建房间请求返回 INVALID_MESSAGE", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_MESSAGE");
  });
});
