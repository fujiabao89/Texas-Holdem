/**
 * Server harness 基础设施自测（TEX-28）。
 *
 * 验证 harness 以生产装配（main.ts 同一接线 + 内存持久化 Fake）真实拉起
 * HTTP/WS 服务：建房 → 邀请码加入 → 入座 → WS 认证 → Ready → 房主开局 →
 * 重连后的 gameSnapshot 屏障与后续事件流。这是 Multiplayer/WS 层用例的
 * 可信基础；本文件不重复业务断言，只证明基础设施可用且无协议违规。
 *
 * 已知缺陷 F-1（见 docs/03-engineering/TEX-28-findings-ledger.md）：开局时
 * 已连接的客户端收不到首手事件。本冒烟测试按当前真实可用的协议路径
 * （开局后重连，RECONNECT_RESULT 携带 gameSnapshot）驱动，不伪造任何消息。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHarness, startServerHarness } from "./server-harness";
import { WsTestClient } from "./ws-client";

let harness: ServerHarness;

beforeAll(async () => {
  harness = await startServerHarness({ seed: 2828 });
});

afterAll(async () => {
  await harness.close();
});

describe("server harness smoke", () => {
  it("drives create -> join -> seat -> ready -> start -> reconnect through real HTTP/WS wiring", { timeout: 30_000 }, async () => {
    // 1. HTTP：建房 + 邀请码加入（真实路由 + Idempotency-Key + Bearer 鉴权）。
    const alice = await harness.createRoom("Alice");
    const inviteCode = alice.roomSnapshot.inviteCode;
    if (inviteCode === null) throw new Error("fresh room must expose an invite code");
    const bob = await harness.joinRoom(inviteCode, "Bob");
    expect(bob.roomSnapshot.players.map((p) => p.displayName).sort()).toEqual(["Alice", "Bob"]);

    // 2. PATCH CHANGE_SEAT：各自入座（seat 唯一性由服务端裁决）。
    const seat = async (session: typeof alice, seatNumber: number, revision: string): Promise<string> => {
      const response = await fetch(`${harness.httpBaseUrl}/api/v1/rooms/${session.roomId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.playerToken}`,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ expectedRoomRevision: revision, operation: { type: "CHANGE_SEAT", seat: seatNumber } }),
      });
      if (response.status !== 200) throw new Error(`seat failed: ${await response.text()}`);
      const body = (await response.json()) as { data: { roomSnapshot: { roomRevision: string; players: { playerId: string; seat: number | null }[] } } };
      expect(body.data.roomSnapshot.players.find((p) => p.playerId === session.playerId)?.seat).toBe(seatNumber);
      return body.data.roomSnapshot.roomRevision;
    };
    // revision 在每次变更后单调递增：以 join 后的最新快照为起点串行入座。
    let roomRevision = bob.roomSnapshot.roomRevision;
    roomRevision = await seat(alice, 0, roomRevision);
    roomRevision = await seat(bob, 1, roomRevision);
    void roomRevision;

    // 3. WS：双客户端认证并 Ready（真实 /api/v1/ws Upgrade + AUTHENTICATE + SET_READY）。
    const aliceLobby = await WsTestClient.open(harness.wsUrl);
    const bobLobby = await WsTestClient.open(harness.wsUrl);
    const aliceAuth = await aliceLobby.authenticate(alice.roomId, alice.playerToken);
    const bobAuth = await bobLobby.authenticate(bob.roomId, bob.playerToken);
    if (!aliceLobby.isReconnectResult(aliceAuth)) throw new Error(`alice auth: ${JSON.stringify(aliceAuth)}`);
    if (!bobLobby.isReconnectResult(bobAuth)) throw new Error(`bob auth: ${JSON.stringify(bobAuth)}`);
    const aliceReadyId = crypto.randomUUID();
    const bobReadyId = crypto.randomUUID();
    aliceLobby.send({ type: "SET_READY", requestId: aliceReadyId, payload: { ready: true } });
    bobLobby.send({ type: "SET_READY", requestId: bobReadyId, payload: { ready: true } });
    expect((await aliceLobby.waitForCommandResult(aliceReadyId)).status).toBe("APPLIED");
    expect((await bobLobby.waitForCommandResult(bobReadyId)).status).toBe("APPLIED");

    // 4. 房主开局（HTTP POST /tournaments，revision 精确匹配）。
    const readySnapshot = await aliceLobby.waitFor(
      (message) => aliceLobby.isRoomSnapshot(message) && message.payload.players.every((p) => p.ready),
      5_000,
      "everyone-ready ROOM_SNAPSHOT",
    );
    const startResponse = await fetch(`${harness.httpBaseUrl}/api/v1/rooms/${alice.roomId}/tournaments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.playerToken}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ expectedRoomRevision: (readySnapshot.payload as { roomRevision: string }).roomRevision }),
    });
    expect(startResponse.status).toBe(200);
    const started = (await startResponse.json()) as { data: { tournamentId: string } };
    const tournamentId = started.data.tournamentId;
    expect(tournamentId).toBeTruthy();

    // 5. F-1 规避路径：开局后重连，RECONNECT_RESULT 携带权威 gameSnapshot。
    const aliceGame = await WsTestClient.open(harness.wsUrl);
    const aliceReconnect = await aliceGame.authenticate(alice.roomId, alice.playerToken);
    if (!aliceGame.isReconnectResult(aliceReconnect)) throw new Error(`alice reconnect: ${JSON.stringify(aliceReconnect)}`);
    const gameSnapshot = aliceReconnect.payload.gameSnapshot;
    if (gameSnapshot === null) throw new Error("reconnect after start must carry a gameSnapshot");
    expect(gameSnapshot.tournamentId).toBe(tournamentId);
    expect(gameSnapshot.viewer.playerId).toBe(alice.playerId);
    expect(gameSnapshot.viewer.holeCards).toHaveLength(2);
    // 6. Bob 同样重连进入比赛视角。
    const bobGame = await WsTestClient.open(harness.wsUrl);
    const bobReconnect = await bobGame.authenticate(bob.roomId, bob.playerToken);
    if (!bobGame.isReconnectResult(bobReconnect)) throw new Error(`bob reconnect: ${JSON.stringify(bobReconnect)}`);
    const bobGameSnapshot = bobReconnect.payload.gameSnapshot;
    if (bobGameSnapshot === null) throw new Error("bob reconnect after start must carry a gameSnapshot");
    expect(bobGameSnapshot.viewer.playerId).toBe(bob.playerId);

    // 重连接管旧连接：旧 socket 以 4001 关闭（SESSION_REPLACED 语义）。
    const aliceLobbyClose = await aliceLobby.closed;
    expect(aliceLobbyClose.code).toBe(4001);
    const bobLobbyClose = await bobLobby.closed;
    expect(bobLobbyClose.code).toBe(4001);

    // 7. 无任何协议违规（每帧均通过 ServerMessageSchema 严格校验）。
    expect(aliceGame.schemaViolations).toEqual([]);
    expect(bobGame.schemaViolations).toEqual([]);

    aliceGame.close();
    bobGame.close();
  });
});
