import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { parseAppConfig } from "./config";
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
