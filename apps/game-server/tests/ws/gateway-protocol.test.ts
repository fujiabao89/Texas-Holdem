/**
 * WS 网关协议行为测试（TEX-28，docs/02-protocol-spec.md §3/§7/§8/§11）。
 *
 * 全部经由真实 HTTP/WS 服务（进程内 harness，生产装配）：认证失败码、
 * 认证超时（Fake Clock）、会话接管 4001、WS 命令幂等（同键同 Payload 重放 /
 * 同键不同 Payload 拒绝）、非法帧与未知字段、心跳断线宽限。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServerHarness, type ServerHarness } from "../../../../tests/clients/server-harness";
import { WsTestClient } from "../../../../tests/clients/ws-client";

let harness: ServerHarness;
const sockets: WsTestClient[] = [];

beforeEach(async () => {
  harness = await startServerHarness({ seed: 2801 });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await harness.close();
});

function track(socket: WsTestClient): WsTestClient {
  sockets.push(socket);
  return socket;
}

async function createSeatedRoom(): Promise<{ roomId: string; hostToken: string; guestToken: string }> {
  const host = await harness.createRoom("Host");
  const inviteCode = host.roomSnapshot.inviteCode;
  if (inviteCode === null) throw new Error("invite code expected");
  const guest = await harness.joinRoom(inviteCode, "Guest");
  const seat = async (session: typeof host, seatNumber: number, revision: string): Promise<string> => {
    const response = await fetch(`${harness.httpBaseUrl}/api/v1/rooms/${session.roomId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.playerToken}`, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRoomRevision: revision, operation: { type: "CHANGE_SEAT", seat: seatNumber } }),
    });
    if (response.status !== 200) throw new Error(await response.text());
    return ((await response.json()) as { data: { roomSnapshot: { roomRevision: string } } }).data.roomSnapshot.roomRevision;
  };
  let revision = guest.roomSnapshot.roomRevision;
  revision = await seat(host, 0, revision);
  await seat(guest, 1, revision);
  return { roomId: host.roomId, hostToken: host.playerToken, guestToken: guest.playerToken };
}

describe("WS 认证", () => {
  it("非法 Token 返回 AUTH_FAILED 并以 4003 关闭", async () => {
    const room = await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    const result = await socket.authenticate(room.roomId, "not-a-valid-token-xxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(socket.isError(result)).toBe(true);
    if (socket.isError(result)) expect(result.payload.code).toBe("AUTH_FAILED");
    const close = await socket.closed;
    expect(close.code).toBe(4003);
  });

  it("认证前发送业务命令返回 AUTH_REQUIRED 并以 4003 关闭", async () => {
    const room = await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    socket.send({ type: "SET_READY", requestId: crypto.randomUUID(), payload: { ready: true } });
    const error = await socket.waitFor((m) => socket.isError(m), 5_000, "AUTH_REQUIRED error");
    if (socket.isError(error)) expect(error.payload.code).toBe("AUTH_REQUIRED");
    const close = await socket.closed;
    expect(close.code).toBe(4003);
  });

  it("5 秒未认证由服务端关闭（Fake Clock，无真实等待）", async () => {
    await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    void socket;
    harness.clock.advance(5_001);
    const close = await socket.closed;
    expect(close.code).toBe(4003);
  });

  it("不兼容协议版本返回 UNSUPPORTED_PROTOCOL_VERSION 并以 4000 关闭", async () => {
    const room = await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    socket.send({
      type: "AUTHENTICATE",
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      payload: { roomId: room.roomId, playerToken: room.playerToken },
    });
    const error = await socket.waitFor((m) => socket.isError(m), 5_000, "version error");
    if (socket.isError(error)) expect(error.payload.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
    const close = await socket.closed;
    expect(close.code).toBe(4000);
  });

  it("非法 JSON 帧返回 INVALID_MESSAGE 且不关闭连接", async () => {
    const room = await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    socket.sendRaw("{not-json");
    const error = await socket.waitFor((m) => socket.isError(m), 5_000, "INVALID_MESSAGE error");
    if (socket.isError(error)) expect(error.payload.code).toBe("INVALID_MESSAGE");
    // 连接仍可用：正常认证成功。
    const result = await socket.authenticate(room.roomId, room.playerToken);
    expect(socket.isReconnectResult(result)).toBe(true);
  });

  it("未知字段被严格 Schema 拒绝（INVALID_MESSAGE）", async () => {
    const room = await harness.createRoom("Host");
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    const auth = await socket.authenticate(room.roomId, room.playerToken);
    expect(socket.isReconnectResult(auth)).toBe(true);
    socket.send({ type: "SET_READY", requestId: crypto.randomUUID(), payload: { ready: true }, evil: "field" });
    const error = await socket.waitFor((m) => socket.isError(m), 5_000, "strict schema error");
    if (socket.isError(error)) expect(error.payload.code).toBe("INVALID_MESSAGE");
  });
});

describe("会话接管", () => {
  it("新连接接管后旧连接收到 SESSION_REPLACED 并以 4001 关闭", async () => {
    const room = await createSeatedRoom();
    const first = track((await WsTestClient.open(harness.wsUrl)));
    const firstAuth = await first.authenticate(room.roomId, room.hostToken);
    expect(first.isReconnectResult(firstAuth)).toBe(true);
    if (first.isReconnectResult(firstAuth)) expect(firstAuth.payload.tookOver).toBe(false);

    const second = track((await WsTestClient.open(harness.wsUrl)));
    const secondAuth = await second.authenticate(room.roomId, room.hostToken);
    expect(second.isReconnectResult(secondAuth)).toBe(true);
    if (second.isReconnectResult(secondAuth)) expect(secondAuth.payload.tookOver).toBe(true);

    const replaced = await first.waitFor((m) => m.type === "SESSION_REPLACED", 5_000, "SESSION_REPLACED");
    expect(replaced.type).toBe("SESSION_REPLACED");
    const close = await first.closed;
    expect(close.code).toBe(4001);
    // 新连接仍可正常执行命令。
    const readyId = crypto.randomUUID();
    second.send({ type: "SET_READY", requestId: readyId, payload: { ready: true } });
    expect((await second.waitForCommandResult(readyId)).status).toBe("APPLIED");
  });
});

describe("WS 命令幂等", () => {
  it("同 requestId 同 Payload 重放返回 duplicate=true 且不重复执行", async () => {
    const room = await createSeatedRoom();
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    expect(socket.isReconnectResult(await socket.authenticate(room.roomId, room.hostToken))).toBe(true);
    const readyId = crypto.randomUUID();
    socket.send({ type: "SET_READY", requestId: readyId, payload: { ready: true } });
    const first = await socket.waitForCommandResult(readyId);
    expect(first.status).toBe("APPLIED");
    expect(first.duplicate).toBe(false);
    socket.send({ type: "SET_READY", requestId: readyId, payload: { ready: true } });
    const replay = await socket.waitForCommandResult(readyId);
    expect(replay.status).toBe("APPLIED");
    expect(replay.duplicate).toBe(true);
  });

  it("同 requestId 不同 Payload 拒绝 IDEMPOTENCY_KEY_REUSE", async () => {
    const room = await createSeatedRoom();
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    expect(socket.isReconnectResult(await socket.authenticate(room.roomId, room.hostToken))).toBe(true);
    const readyId = crypto.randomUUID();
    socket.send({ type: "SET_READY", requestId: readyId, payload: { ready: true } });
    expect((await socket.waitForCommandResult(readyId)).status).toBe("APPLIED");
    socket.send({ type: "SET_READY", requestId: readyId, payload: { ready: false } });
    const conflict = await socket.waitForCommandResult(readyId);
    expect(conflict.status).toBe("REJECTED");
    expect(conflict.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });
});

describe("心跳（Fake Clock 驱动，docs/02 §3）", () => {
  it("45 秒无活动（未响应 ping）后连接被终止", async () => {
    const room = await createSeatedRoom();
    const socket = track((await WsTestClient.open(harness.wsUrl)));
    expect(socket.isReconnectResult(await socket.authenticate(room.roomId, room.hostToken))).toBe(true);
    harness.clock.advance(45_000);
    const close = await socket.closed;
    expect(close.code).toBe(1006); // terminate：异常关闭，无 close frame
  });
});
