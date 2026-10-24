import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { startServerHarness } from "../../../../tests/clients/server-harness";
import { WsTestClient } from "../../../../tests/clients/ws-client";
import { DEALING_DISPLAY_MS, SHOWDOWN_DISPLAY_MS } from "../../src/tournaments/tournament-executor";

it("TEX-48: real HTTP/WS reconnects during both locked phases, reopens with original code and starts a fresh tournament", async () => {
  const h = await startServerHarness({ seed: 2801 });
  const sockets: WsTestClient[] = [];
  try {
    const host = await h.createRoom("Host", { maxPlayers: 3 });
    const code = host.roomSnapshot.inviteCode!;
    const guest = await h.joinRoom(code, "Guest");
    const room = () => h.roomManager.getSnapshot(host.roomId)!;
    const connect = async (session: typeof host) => {
      const socket = await WsTestClient.open(h.wsUrl);
      sockets.push(socket);
      const result = await socket.authenticate(session.roomId, session.playerToken);
      expect(result.type).toBe("RECONNECT_RESULT");
      if (result.type !== "RECONNECT_RESULT") throw new Error("authentication failed");
      expect(result.payload.roomSnapshot.inviteCode).toBe(room().status === "LOBBY" ? code : null);
      return socket;
    };
    let hostSocket = await connect(host);
    let guestSocket = await connect(guest);
    const request = async (method: string, path: string, payload: unknown, token?: string) => {
      const response = await fetch(`${h.httpBaseUrl}/api/v1/${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    const ready = async (socket: WsTestClient) => {
      const requestId = randomUUID();
      socket.send({ type: "SET_READY", requestId, payload: { ready: true } });
      const result = await socket.waitForCommandResult(requestId);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("APPLIED");
    };
    for (const [seat, session] of [host, guest].entries()) {
      expect(
        (
          await request(
            "PATCH",
            `rooms/${host.roomId}`,
            { expectedRoomRevision: room().roomRevision, operation: { type: "CHANGE_SEAT", seat } },
            session.playerToken,
          )
        ).status,
      ).toBe(200);
    }
    await ready(hostSocket);
    await ready(guestSocket);
    const started = await request(
      "POST",
      `rooms/${host.roomId}/tournaments`,
      { expectedRoomRevision: room().roomRevision },
      host.playerToken,
    );
    expect(started.status).toBe(200);
    const oldId = started.body.data.tournamentId as string;
    guestSocket = await connect(guest);
    expect(
      (await request("POST", "rooms/join", { inviteCode: code, displayName: "Locked" })).body.error
        .code,
    ).toBe("ROOM_LOCKED");
    for (
      let actions = 0;
      actions < 100 && h.tournamentManager.getView(oldId)!.status !== "FINISHED";
      actions++
    ) {
      const view = h.tournamentManager.getView(oldId)!;
      if (view.presentationPhase === "DEALING" || view.presentationPhase === "SHOWDOWN_DISPLAY") {
        h.clock.advance(
          view.presentationPhase === "DEALING" ? DEALING_DISPLAY_MS : SHOWDOWN_DISPLAY_MS,
        );
        await h.tournamentManager.setConnection(oldId, host.playerId, true);
        continue;
      }
      const actor = view.seatToPlayer.get(view.engineState.hand!.currentActor!)!;
      const socket = actor === host.playerId ? hostSocket : guestSocket;
      const requestId = randomUUID();
      socket.send({
        type: "SUBMIT_ACTION",
        requestId,
        payload: {
          tournamentId: oldId,
          actionId: randomUUID(),
          expectedSequence: String(view.lastWireSequence),
          action: {
            type: view.currentLegalActions?.canAllIn
              ? "ALL_IN"
              : view.currentLegalActions?.canCall
                ? "CALL"
                : "CHECK",
          },
        },
      });
      const result = await socket.waitForCommandResult(requestId);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("APPLIED");
    }
    await hostSocket.waitFor(
      (message) => message.type === "ROOM_SNAPSHOT" && message.payload.status === "FINISHED",
      5000,
      "finished room",
    );
    hostSocket = await connect(host);
    expect(room().status).toBe("FINISHED");
    expect(
      (await request("POST", "rooms/join", { inviteCode: code, displayName: "Locked2" })).body.error
        .code,
    ).toBe("ROOM_LOCKED");
    expect(
      (
        await request(
          "POST",
          `rooms/${host.roomId}/tournaments`,
          { expectedRoomRevision: room().roomRevision },
          host.playerToken,
        )
      ).body.error.code,
    ).toBe("ROOM_LOCKED");
    const reopened = await request(
      "PATCH",
      `rooms/${host.roomId}`,
      { expectedRoomRevision: room().roomRevision, operation: { type: "REOPEN_LOBBY" } },
      host.playerToken,
    );
    expect(reopened.status).toBe(200);
    expect(room().players.every((p) => !p.ready && p.pokerStatus === "ACTIVE")).toBe(true);
    expect(room().players.map((p) => p.seat)).toEqual([0, 1]);
    const newcomer = await h.joinRoom(code, "Newcomer");
    expect(room().players.find((p) => p.playerId === newcomer.playerId)).toMatchObject({
      seat: null,
      ready: false,
    });
    await ready(hostSocket);
    await ready(guestSocket);
    expect(
      (
        await request(
          "POST",
          `rooms/${host.roomId}/tournaments`,
          { expectedRoomRevision: room().roomRevision },
          host.playerToken,
        )
      ).body.error.code,
    ).toBe("INVALID_ACTION");
    const newSocket = await connect(newcomer);
    expect(
      (
        await request(
          "PATCH",
          `rooms/${host.roomId}`,
          {
            expectedRoomRevision: room().roomRevision,
            operation: { type: "CHANGE_SEAT", seat: 2 },
          },
          newcomer.playerToken,
        )
      ).status,
    ).toBe(200);
    await ready(newSocket);
    const next = await request(
      "POST",
      `rooms/${host.roomId}/tournaments`,
      { expectedRoomRevision: room().roomRevision },
      host.playerToken,
    );
    expect(next.status).toBe(200);
    expect(next.body.data.tournamentId).not.toBe(oldId);
    expect(h.tournamentManager.activeTournamentIds()).toEqual([next.body.data.tournamentId]);
    expect(h.tournamentManager.getView(oldId)!.status).toBe("FINISHED");
    const persisted = h.roomRepository.room(host.roomId)!.tournaments;
    expect(persisted.map((t) => t.tournamentNo)).toEqual([1, 2]);
    expect(persisted[1]!.players.every((p) => p.startingStack === 1000n)).toBe(true);
    for (const socket of sockets) expect(socket.schemaViolations).toEqual([]);
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});
