import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpdateRoomRequestSchema,
  RoomSnapshotSchema,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { buildApp } from "../app";
import { parseAppConfig } from "../config";
import { createRoomManager, type PlayerSession } from "./room-manager";
import { HOST_GRACE_MS, RoomRuntime } from "./room-executor";
import {
  createRoomState,
  joinRoom,
  changeSeat,
  setReady,
  startTournament,
  markTournamentFinished,
  reopenLobby,
} from "./room-runtime";
import { fakePersistence, fakeRoomRepository } from "./test-support";
import type { TournamentStartRequest } from "./tournament-starter";

const CONFIG: TournamentConfig = {
  maxPlayers: 4,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 60,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function table() {
  const clock = createFakeClock({ now: 1000 });
  const persistence = fakePersistence();
  const starts: TournamentStartRequest[] = [];
  persistence.startTournament = async (request) => {
    starts.push(request);
  };
  const rooms = createRoomManager({
    persistence,
    roomRepository: fakeRoomRepository(),
    ids: { uuid: randomUUID, randomBytes, now: () => clock.now() },
    scheduler: clock,
    clock: () => clock.now(),
    tokenSecret: "tex48-test-secret-0000000000000001",
    tokenKeyId: "k1",
  });
  const app = buildApp({
    config: parseAppConfig({ TOKEN_HMAC_SECRET: "tex48-test-secret-0000000000000001" }),
    roomManager: rooms,
    now: () => clock.now(),
  });
  cleanups.push(async () => {
    await app.close();
    await rooms.dispose();
    clock.dispose();
  });
  const host = await rooms.createRoom({
    displayName: "Host",
    displayNameKey: "host",
    config: CONFIG,
  });
  const code = host.roomSnapshot.inviteCode!;
  const guest = await rooms.joinRoom({
    inviteCode: code,
    displayName: "Guest",
    displayNameKey: "guest",
  });
  const snapshot = () => rooms.getSnapshot(host.roomId)!;
  const revision = () => Number(snapshot().roomRevision);
  const command = (value: Parameters<typeof rooms.submitCommand>[1]) =>
    rooms.submitCommand(host.roomId, value);
  const ready = async (players = [host, guest]) => {
    for (const [seat, player] of players.entries()) {
      await command({ type: "CHANGE_SEAT", playerId: player.playerId, seat });
      await command({ type: "SET_READY", playerId: player.playerId, ready: true });
    }
  };
  const start = (tournamentId: string = randomUUID()) =>
    command({
      type: "START_TOURNAMENT",
      actorPlayerId: snapshot().hostPlayerId!,
      expectedRevision: revision(),
      tournamentId,
    });
  const finish = async () => {
    const id = snapshot().activeTournamentId!;
    await command({ type: "TOURNAMENT_FINISHED", tournamentId: id });
  };
  const reopen = () =>
    command({
      type: "REOPEN_LOBBY",
      actorPlayerId: snapshot().hostPlayerId!,
      expectedRevision: revision(),
    });
  const patch = (
    actor = host,
    expected = snapshot().roomRevision,
    key = randomUUID(),
    operation = { type: "REOPEN_LOBBY" },
  ) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${host.roomId}`,
      headers: { authorization: `Bearer ${actor.playerToken}`, "idempotency-key": key },
      payload: { expectedRoomRevision: expected, operation },
    });
  return {
    clock,
    persistence,
    starts,
    rooms,
    app,
    host,
    guest,
    code,
    snapshot,
    revision,
    command,
    ready,
    start,
    finish,
    reopen,
    patch,
  };
}

describe("TEX-48 explicit preparatory lobby", () => {
  it("HTTP gates invites, replays reopen once, restores the same code and requires every new participant to prepare", async () => {
    const h = await table();
    await h.ready();
    await h.start("old");
    const join = () =>
      h.app.inject({
        method: "POST",
        url: "/api/v1/rooms/join",
        headers: { "idempotency-key": randomUUID() },
        payload: { inviteCode: h.code, displayName: "Newcomer" },
      });
    for (const phase of ["IN_GAME", "FINISHED"]) {
      expect(h.snapshot().status).toBe(phase);
      expect(h.snapshot().inviteCode).toBeNull();
      expect((await join()).json().error.code).toBe("ROOM_LOCKED");
      expect(h.rooms.authenticate(h.host.roomId, h.guest.playerToken)).toBe(h.guest.playerId);
      if (phase === "IN_GAME") await h.finish();
    }
    await expect(h.start("blocked")).rejects.toThrow("ROOM_LOCKED");
    const beforeRevision = h.revision();
    const key = randomUUID();
    const [first, replay] = await Promise.all([
      h.patch(h.host, String(beforeRevision), key),
      h.patch(h.host, String(beforeRevision), key),
    ]);
    expect(first.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(h.revision()).toBe(beforeRevision + 1);
    expect(h.persistence.calls.filter((c) => c === "setRoomStatus:LOBBY")).toHaveLength(1);
    expect(h.snapshot()).toMatchObject({
      status: "LOBBY",
      inviteCode: h.code,
      activeTournamentId: null,
    });
    expect(h.snapshot().players.every((p) => !p.ready && p.pokerStatus === "ACTIVE")).toBe(true);
    const joined = await join();
    expect(joined.statusCode).toBe(200);
    const newcomer = joined.json().data as PlayerSession;
    expect(
      newcomer.roomSnapshot.players.find((p) => p.playerId === newcomer.playerId),
    ).toMatchObject({ seat: null, ready: false });
    await h.ready();
    await expect(h.start()).rejects.toThrow("INVALID_ACTION");
    await h.ready([h.host, h.guest, newcomer]);
    await h.start("new");
    expect(h.starts.map((r) => [r.tournamentId, r.tournamentNo])).toEqual([
      ["old", 1],
      ["new", 2],
    ]);
    expect(h.starts[1]!.players).toHaveLength(3);
    expect(h.starts[1]!.players.every((p) => p.startingStack === 1000n)).toBe(true);
    expect(
      h.starts[1]!.players.map((p) => p.id).some((id) =>
        h.starts[0]!.players.some((old) => old.id === id),
      ),
    ).toBe(false);
    expect(h.snapshot().inviteCode).toBeNull();
  });

  it("strict shared schemas and HTTP reject forged fields, non-host, wrong phase, stale revision and changed idempotency payload", async () => {
    const h = await table();
    expect(
      UpdateRoomRequestSchema.safeParse({
        expectedRoomRevision: "2",
        operation: { type: "REOPEN_LOBBY", playerId: h.host.playerId },
      }).success,
    ).toBe(false);
    expect((await h.patch()).json().error.code).toBe("ROOM_LOCKED");
    await h.ready();
    await h.start();
    await h.finish();
    const before = h.snapshot();
    expect((await h.patch(h.guest)).json().error.code).toBe("NOT_HOST");
    expect((await h.patch(h.host, "1")).json().error.code).toBe("STALE_ROOM_STATE");
    expect(h.snapshot()).toEqual(before);
    const key = randomUUID();
    expect((await h.patch(h.host, before.roomRevision, key)).statusCode).toBe(200);
    expect((await h.patch(h.host, before.roomRevision)).json().error.code).toBe("STALE_ROOM_STATE");
    expect((await h.patch()).json().error.code).toBe("ROOM_LOCKED");
    expect((await h.patch(h.host, h.snapshot().roomRevision, key)).json().error.code).toBe(
      "IDEMPOTENCY_KEY_REUSE",
    );
    for (const status of ["IN_GAME", "FINISHED", "CLOSED"] as const) {
      expect(
        RoomSnapshotSchema.safeParse({ ...h.snapshot(), status, inviteCode: h.code }).success,
      ).toBe(false);
      expect(
        RoomSnapshotSchema.safeParse({ ...h.snapshot(), status, inviteCode: null }).success,
      ).toBe(true);
    }
  });

  it("offline ready players block start; config and seat changes reset readiness; removed members never return", async () => {
    const h = await table();
    await h.ready();
    await h.command({
      type: "SET_CONNECTION_STATUS",
      playerId: h.guest.playerId,
      connectionStatus: "DISCONNECTED",
    });
    await expect(h.start()).rejects.toThrow("INVALID_ACTION");
    await h.command({
      type: "SET_CONNECTION_STATUS",
      playerId: h.guest.playerId,
      connectionStatus: "CONNECTED",
    });
    await h.start();
    await h.finish();
    await h.command({
      type: "LEAVE",
      playerId: h.guest.playerId,
      reason: "USER_LEFT",
      leftAt: h.clock.now(),
    });
    await h.reopen();
    expect(h.snapshot().players.map((p) => p.playerId)).toEqual([h.host.playerId]);
    await h.ready([h.host]);
    await expect(h.start()).rejects.toThrow("INVALID_ACTION");
    await h.command({
      type: "UPDATE_CONFIG",
      actorPlayerId: h.host.playerId,
      config: { ...CONFIG, startingStack: 2000 },
    });
    expect(h.snapshot().players.every((p) => !p.ready)).toBe(true);
    await h.command({ type: "SET_READY", playerId: h.host.playerId, ready: true });
    await h.command({ type: "CHANGE_SEAT", playerId: h.host.playerId, seat: 3 });
    expect(h.snapshot().players[0]!.ready).toBe(false);
    expect(() => h.rooms.authenticate(h.host.roomId, h.guest.playerToken)).toThrow("AUTH_FAILED");
  });

  it.each([true, false])(
    "join/start arbitration follows queue order (join first: %s) and rejects late old terminal signals",
    async (joinFirst) => {
      const h = await table();
      await h.ready();
      await h.start("old");
      await h.finish();
      await h.reopen();
      await expect(h.command({ type: "TOURNAMENT_FINISHED", tournamentId: "old" })).rejects.toThrow(
        "TOURNAMENT_NOT_ACTIVE",
      );
      await h.ready();
      const join = () =>
        h.rooms.joinRoom({ inviteCode: h.code, displayName: "New", displayNameKey: "new" });
      const start = () => h.start("new");
      const tasks = joinFirst ? [join(), start()] : [start(), join()];
      const outcomes = await Promise.allSettled(tasks);
      expect(outcomes[0]!.status).toBe("fulfilled");
      expect(outcomes[1]).toMatchObject({
        status: "rejected",
        reason: { code: joinFirst ? "STALE_ROOM_STATE" : "ROOM_LOCKED" },
      });
      expect(h.starts).toHaveLength(joinFirst ? 1 : 2);
      if (!joinFirst) {
        await expect(
          h.command({ type: "TOURNAMENT_FINISHED", tournamentId: "old" }),
        ).rejects.toThrow("TOURNAMENT_NOT_ACTIVE");
        await expect(
          h.command({ type: "CLOSE_ROOM", tournamentId: "old", reason: "late" }),
        ).rejects.toThrow("TOURNAMENT_NOT_ACTIVE");
        expect(h.snapshot().activeTournamentId).toBe("new");
      }
    },
  );

  it("automatic Host Grace publishes the new host before it can reopen, and a FINISHED host departure transfers immediately", async () => {
    const h = await table();
    await h.ready();
    await h.start();
    await h.finish();
    const published: string[] = [];
    h.rooms.subscribe((snapshot) => published.push(snapshot.hostPlayerId ?? "none"));
    await h.command({
      type: "SET_CONNECTION_STATUS",
      playerId: h.host.playerId,
      connectionStatus: "DISCONNECTED",
    });
    h.clock.advance(HOST_GRACE_MS);
    await h.command({
      type: "SET_CONNECTION_STATUS",
      playerId: h.guest.playerId,
      connectionStatus: "CONNECTED",
    });
    expect(h.snapshot().hostPlayerId).toBe(h.guest.playerId);
    expect(published).toContain(h.guest.playerId);
    expect((await h.patch(h.guest)).statusCode).toBe(200);
    await h.command({
      type: "SET_CONNECTION_STATUS",
      playerId: h.host.playerId,
      connectionStatus: "CONNECTED",
    });
    await h.ready();
    await h.start();
    await h.finish();
    await h.command({
      type: "LEAVE",
      playerId: h.guest.playerId,
      reason: "USER_LEFT",
      leftAt: h.clock.now(),
    });
    expect(h.snapshot().hostPlayerId).toBe(h.host.playerId);
    await h.reopen();
    expect(h.snapshot().players.map((p) => p.playerId)).toEqual([h.host.playerId]);
  });

  it("reopen persistence failure leaves FINISHED unchanged; CLOSED permanently denies joining the old room", async () => {
    const h = await table();
    await h.ready();
    await h.start();
    await h.finish();
    const before = h.snapshot();
    const original = h.persistence.setRoomStatus;
    h.persistence.setRoomStatus = vi.fn().mockRejectedValueOnce(new Error("test-db-down"));
    expect((await h.patch()).statusCode).toBe(500);
    expect(h.snapshot()).toEqual(before);
    h.persistence.setRoomStatus = original;
    await h.reopen();
    await h.command({ type: "CLOSE_ROOM", reason: "ABANDONED_NO_HUMAN" });
    await expect(
      h.rooms.joinRoom({ inviteCode: h.code, displayName: "New", displayNameKey: "new" }),
    ).rejects.toThrow("INVITE_EXPIRED");
    expect(() => h.rooms.authenticate(h.host.roomId, h.host.playerToken)).toThrow("ROOM_NOT_FOUND");
  });
});

function finishedRuntime() {
  const clock = createFakeClock({ now: 1000 });
  const seed = (playerId: string, joinedAt: number) => ({
    playerId,
    displayName: playerId,
    displayNameKey: playerId,
    joinedAt,
  });
  let state = createRoomState({
    roomId: "r",
    inviteCode: "ABCDEF",
    host: seed("host", 1),
    config: CONFIG,
  });
  state = joinRoom(state, seed("guest", 2));
  for (const [seat, player] of ["host", "guest"].entries()) {
    state = changeSeat(state, player, seat);
    state = setReady(state, player, true);
  }
  state = markTournamentFinished(
    startTournament(state, {
      actorPlayerId: "host",
      expectedRevision: state.roomRevision,
      tournamentId: "old",
    }),
    "old",
  );
  const persistence = fakePersistence();
  const runtime = new RoomRuntime(state, {
    persistence,
    scheduler: clock,
    clock: () => clock.now(),
    ids: { uuid: randomUUID, randomBytes, now: () => clock.now() },
  });
  cleanups.push(async () => {
    await runtime.dispose();
    expect(clock.pendingTimers()).toBe(0);
    clock.dispose();
  });
  const presence = (playerId: string, connectionStatus: "CONNECTED" | "DISCONNECTED") =>
    runtime.submit({ type: "SET_CONNECTION_STATUS", playerId, connectionStatus });
  // A same-queue barrier: the timer already submitted its command before this presence update.
  const advance = async (ms: number) => {
    clock.advance(ms);
    await runtime.submit({ type: "HOST_GRACE_EXPIRED", hostPlayerId: "obsolete", generation: -1 });
  };
  return { clock, runtime, persistence, presence, advance };
}

describe("TEX-48 Host Grace in FINISHED/LOBBY", () => {
  it.each(["FINISHED", "LOBBY"] as const)(
    "transfers at 60000ms in %s, permits reopen, and never restores the old host on reconnect",
    async (phase) => {
      const h = finishedRuntime();
      if (phase === "LOBBY")
        await h.runtime.submit({
          type: "REOPEN_LOBBY",
          actorPlayerId: "host",
          expectedRevision: h.runtime.current.roomRevision,
        });
      await h.presence("host", "DISCONNECTED");
      await h.advance(HOST_GRACE_MS - 1);
      expect(h.runtime.current.hostPlayerId).toBe("host");
      await h.advance(1);
      expect(h.runtime.current.hostPlayerId).toBe("guest");
      expect(h.persistence.calls).toContain("setRoomHost");
      await h.presence("host", "CONNECTED");
      expect(h.runtime.current.hostPlayerId).toBe("guest");
      if (phase === "FINISHED")
        await h.runtime.submit({
          type: "REOPEN_LOBBY",
          actorPlayerId: "guest",
          expectedRevision: h.runtime.current.roomRevision,
        });
      expect(h.runtime.current.status).toBe("LOBBY");
    },
  );

  it("reconnection cancels the old generation even when its timer command is queued", async () => {
    const h = finishedRuntime();
    await h.presence("host", "DISCONNECTED");
    const reconnect = h.presence("host", "CONNECTED");
    h.clock.advance(HOST_GRACE_MS);
    await reconnect;
    await h.advance(0);
    expect(h.runtime.current.hostPlayerId).toBe("host");
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("no online successor at expiry waits for the first returning human; active departure transfers immediately", async () => {
    const h = finishedRuntime();
    await h.presence("host", "DISCONNECTED");
    await h.presence("guest", "DISCONNECTED");
    await h.advance(HOST_GRACE_MS);
    expect(h.runtime.current.hostPlayerId).toBe("host");
    await h.presence("guest", "CONNECTED");
    expect(h.runtime.current.hostPlayerId).toBe("guest");
    await h.presence("host", "CONNECTED");
    await h.runtime.submit({
      type: "LEAVE",
      playerId: "guest",
      reason: "USER_LEFT",
      leftAt: h.clock.now(),
    });
    expect(h.runtime.current.hostPlayerId).toBe("host");
  });

  it("failed Host persistence retries without committing a false host; dispose cancels pending grace", async () => {
    const h = finishedRuntime();
    const setHost = vi
      .fn()
      .mockRejectedValueOnce(new Error("test transient failure"))
      .mockResolvedValue(undefined);
    h.persistence.setRoomHost = setHost;
    await h.presence("host", "DISCONNECTED");
    await h.advance(HOST_GRACE_MS);
    expect(h.runtime.current.hostPlayerId).toBe("host");
    await h.advance(1000);
    expect(h.runtime.current.hostPlayerId).toBe("guest");
    expect(setHost).toHaveBeenCalledTimes(2);
    await h.presence("guest", "DISCONNECTED");
    await h.runtime.dispose();
    h.clock.advance(HOST_GRACE_MS);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("retained P1 bots default ready and receive fresh participant seeds; bots alone cannot start", async () => {
    const h = finishedRuntime();
    const members = new Map(h.runtime.current.members);
    members.set("guest", {
      ...members.get("guest")!,
      kind: "BOT",
      connectionStatus: "DISCONNECTED",
      ready: false,
    });
    const state = reopenLobby({ ...h.runtime.current, members }, "host");
    expect(state.members.get("guest")!.ready).toBe(true);
    const starts: TournamentStartRequest[] = [];
    const runtime = new RoomRuntime(state, {
      persistence: {
        ...fakePersistence(),
        startTournament: async (request) => {
          starts.push(request);
        },
      },
      scheduler: h.clock,
      ids: { uuid: randomUUID, randomBytes, now: () => h.clock.now() },
    });
    await runtime.submit({ type: "SET_READY", playerId: "host", ready: true });
    await runtime.submit({
      type: "START_TOURNAMENT",
      actorPlayerId: "host",
      tournamentId: "bot-round",
      expectedRevision: runtime.current.roomRevision,
    });
    expect(starts[0]!.players.map((p) => p.kind)).toEqual(["HUMAN", "BOT"]);
    await runtime.dispose();
    members.set("host", { ...members.get("host")!, kind: "BOT" });
    const botLobby = reopenLobby({ ...h.runtime.current, members }, "host");
    expect(() =>
      startTournament(botLobby, {
        actorPlayerId: "host",
        tournamentId: "invalid",
        expectedRevision: botLobby.roomRevision,
      }),
    ).toThrow("INVALID_ACTION");
  });

  it("reopen resets eliminated members, preserves legal seats and excludes removed members", () => {
    const h = finishedRuntime();
    const state = h.runtime.current;
    const members = new Map(state.members);
    members.set("guest", { ...members.get("guest")!, pokerStatus: "ELIMINATED", seat: 12 });
    const lobby = reopenLobby({ ...state, members }, "host");
    expect(lobby.members.get("host")).toMatchObject({
      seat: 0,
      ready: false,
      pokerStatus: "ACTIVE",
    });
    expect(lobby.members.get("guest")).toMatchObject({
      seat: null,
      ready: false,
      pokerStatus: "ACTIVE",
    });
    expect(lobby.members.size).toBe(2);
  });
});
