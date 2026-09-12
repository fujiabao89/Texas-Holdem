import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import {
  PROTOCOL_VERSION,
  type CommandResultPayload,
  type ServerMessage,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { buildApp } from "../app";
import { parseAppConfig } from "../config";
import { IdempotencyStore } from "../http/middleware/idempotency";
import { createConnectionEpochRegistry } from "../realtime/connection-epochs";
import { registerLobbyGateway } from "../realtime/gateway/lobby-gateway";
import { createTournamentEventBus } from "../realtime/tournament-event-bus";
import type { TournamentCommand } from "../tournaments/tournament-commands";
import { createTournamentManager } from "../tournaments/tournament-manager";
import {
  CLOSED_ROOM_RETENTION_MS,
  createRoomManager,
  type PlayerSession,
  type RoomManager,
} from "./room-manager";
import { createRuntimeTournamentRegistrar } from "./tournament-starter";
import { fakePersistence, fakeRoomRepository } from "./test-support";

const CONFIG: TournamentConfig = {
  maxPlayers: 2,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 0,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RaceSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  failClosedSnapshot = false;
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  private readonly waiters = new Set<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as ServerMessage;
    if (
      this.failClosedSnapshot &&
      message.type === "ROOM_SNAPSHOT" &&
      "status" in message.payload &&
      message.payload.status === "CLOSED"
    ) {
      throw new Error("socket transport failed");
    }
    this.messages.push(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }
  receive(message: unknown): void {
    for (const listener of this.listeners.get("message") ?? [])
      listener(Buffer.from(JSON.stringify(message)));
  }
  close(code = 1000): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener(code);
  }
  ping(): void {}
  terminate(): void {
    this.close(1006);
  }
  next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    return new Promise((resolve) => this.waiters.add({ predicate, resolve }));
  }
}

function setup(onClosed?: () => Promise<void>) {
  const clock = createFakeClock({ now: 1000 });
  let id = 0;
  let random = 0;
  const ids = {
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: clock.now,
    randomBytes: (count: number) => Uint8Array.from({ length: count }, () => random++ % 248),
  };
  const epochs = createConnectionEpochRegistry();
  const events = createTournamentEventBus();
  const pendingRoomCommands = new Set<Promise<unknown>>();
  // eslint-disable-next-line prefer-const -- output wiring closes over the later RoomManager, like main.ts.
  let rooms: RoomManager;
  const tournaments = createTournamentManager({
    clock: clock.now,
    ids,
    scheduler: clock,
    output: {
      emitEvents: events.emitEvents,
      emitClockUpdated: events.emitClockUpdated,
      enqueueCommitBundles: () => undefined,
      submitRoomCommand(roomId, command) {
        const pending = rooms.submitCommand(roomId, command);
        pendingRoomCommands.add(pending);
        void pending.finally(() => pendingRoomCommands.delete(pending)).catch(() => undefined);
      },
    },
    executorDeps: { isConnectionCurrent: epochs.isCurrent },
  });
  const registrar = createRuntimeTournamentRegistrar({
    manager: tournaments,
    rngFactory: () => new SeededRandomSource(52),
  });
  rooms = createRoomManager({
    persistence: fakePersistence(),
    roomRepository: fakeRoomRepository(),
    ids,
    tokenSecret: "tex52-race-tests-only-token-secret",
    tokenKeyId: "test",
    scheduler: clock,
    clock: clock.now,
    isConnectionCurrent: epochs.isCurrent,
    onStartCommitted: registrar.register,
    async onClosed(roomId) {
      await onClosed?.();
      epochs.forgetRoom(roomId);
      await tournaments.disposeRoom(roomId);
    },
  });
  const cleanupHooks: (() => Promise<void>)[] = [];
  let accept!: (socket: RaceSocket) => void;
  const app = {
    addHook(_name: string, callback: () => Promise<void>) {
      cleanupHooks.push(callback);
    },
    get(_path: string, _options: unknown, callback: (socket: RaceSocket) => void) {
      accept = callback;
    },
  } as unknown as FastifyInstance;
  registerLobbyGateway(app, rooms, {
    now: clock.now,
    ids,
    idempotency: new IdempotencyStore(),
    clock,
    epochs,
    tournaments,
    events,
  });

  async function connect(session: PlayerSession): Promise<RaceSocket> {
    const socket = new RaceSocket();
    accept(socket);
    const result = socket.next(
      (message) => message.type === "RECONNECT_RESULT" || message.type === "ERROR",
    );
    socket.receive({
      type: "AUTHENTICATE",
      protocolVersion: PROTOCOL_VERSION,
      requestId: ids.uuid(),
      payload: { roomId: session.roomId, playerToken: session.playerToken },
    });
    expect((await result).type).toBe("RECONNECT_RESULT");
    return socket;
  }

  async function drainRooms() {
    while (pendingRoomCommands.size > 0) await Promise.all([...pendingRoomCommands]);
  }

  async function startTable() {
    const host = await rooms.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: CONFIG,
    });
    const guest = await rooms.joinRoom({
      inviteCode: host.roomSnapshot.inviteCode!,
      displayName: "Guest",
      displayNameKey: "guest",
    });
    const sockets = new Map<string, RaceSocket>();
    for (const [seat, player] of [host, guest].entries()) {
      sockets.set(player.playerId, await connect(player));
      await rooms.submitCommand(host.roomId, {
        type: "CHANGE_SEAT",
        playerId: player.playerId,
        seat,
      });
      await rooms.submitCommand(host.roomId, {
        type: "SET_READY",
        playerId: player.playerId,
        ready: true,
      });
    }
    const tournamentId = ids.uuid();
    await rooms.submitCommand(host.roomId, {
      type: "START_TOURNAMENT",
      actorPlayerId: host.playerId,
      expectedRevision: Number(rooms.getSnapshot(host.roomId)!.roomRevision),
      tournamentId,
    });
    await tournaments.setConnection(tournamentId, host.playerId, true);
    return { host, guest, sockets, tournamentId };
  }

  async function finishTable() {
    const { host, guest, sockets, tournamentId } = await startTable();
    let last!: Extract<TournamentCommand, { type: "SUBMIT_ACTION" }>;
    for (let action = 0; action < 100; action++) {
      const view = tournaments.getView(tournamentId)!;
      if (view.status === "FINISHED") {
        await drainRooms();
        return { host, guest, sockets, tournamentId, last };
      }
      const legal = view.currentLegalActions!;
      last = {
        type: "SUBMIT_ACTION",
        playerId: view.seatToPlayer.get(view.engineState.hand!.currentActor!)!,
        requestId: ids.uuid(),
        actionId: ids.uuid(),
        expectedSequence: String(view.lastWireSequence),
        action: legal.canAllIn
          ? { type: "ALL_IN" }
          : legal.canCall
            ? { type: "CALL" }
            : { type: "CHECK" },
        receivedAt: clock.now(),
        ingressOrdinal: action + 1,
      };
      expect(((await tournaments.submit(tournamentId, last)) as CommandResultPayload).status).toBe(
        "APPLIED",
      );
    }
    throw new Error("deterministic fixture did not finish");
  }

  async function dispose() {
    await Promise.all(cleanupHooks.map((cleanup) => cleanup()));
    await rooms.dispose();
    await tournaments.dispose();
    clock.dispose();
  }
  return { clock, ids, rooms, tournaments, connect, startTable, finishTable, drainRooms, dispose };
}

describe("TEX-52 Room lifecycle cross-owner races", () => {
  it("allows the final successful action to replay through WS while its terminal Runtime is retained", async () => {
    const h = setup();
    try {
      const { host, sockets, tournamentId, last } = await h.finishTable();
      expect(h.rooms.getSnapshot(host.roomId)).toMatchObject({
        status: "FINISHED",
        activeTournamentId: null,
      });
      expect(h.tournaments.getView(tournamentId)?.status).toBe("FINISHED");
      const socket = sockets.get(last.playerId)!;
      const result = socket.next(
        (message) =>
          message.type === "COMMAND_RESULT" &&
          "requestId" in message.payload &&
          message.payload.requestId === last.requestId,
      );
      socket.receive({
        type: "SUBMIT_ACTION",
        requestId: last.requestId,
        payload: {
          tournamentId,
          actionId: last.actionId,
          expectedSequence: last.expectedSequence,
          action: last.action,
        },
      });
      expect((await result).payload).toMatchObject({
        status: "APPLIED",
        duplicate: true,
        actionId: last.actionId,
      });
    } finally {
      await h.dispose();
    }
  });

  it("serves the terminal final Snapshot to an existing member during retention", async () => {
    const h = setup();
    try {
      const { host, sockets, tournamentId } = await h.finishTable();
      const socket = sockets.get(host.playerId)!;
      const snapshot = socket.next(
        (message) => message.type === "GAME_SNAPSHOT" || message.type === "ERROR",
      );
      socket.receive({
        type: "REQUEST_SNAPSHOT",
        requestId: h.ids.uuid(),
        payload: { tournamentId, lastSequence: "0", reason: "GAP" },
      });
      expect(await snapshot).toMatchObject({
        type: "GAME_SNAPSHOT",
        payload: { tournamentId, tournamentStatus: "FINISHED", reason: "RESYNC" },
      });
    } finally {
      await h.dispose();
    }
  });

  it("reclaims local Room ownership and eventually expires its tombstone even if downstream cleanup rejects", async () => {
    const h = setup(async () => {
      throw new Error("downstream cleanup failed");
    });
    try {
      const host = await h.rooms.createRoom({
        displayName: "Host",
        displayNameKey: "host",
        config: CONFIG,
      });
      await h.rooms
        .submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "TEST_CLOSED" })
        .catch(() => undefined);
      expect(h.rooms.runtimeCounts().registered).toBe(0);
      expect(h.rooms.getTombstone(host.roomId)).toBeDefined();
      h.clock.advance(CLOSED_ROOM_RETENTION_MS);
      expect(h.rooms.getTombstone(host.roomId)).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it("does not close the last leaver's WS before its successful acknowledgement when cleanup is asynchronous", async () => {
    const cleanupEntered = deferred();
    const cleanupRelease = deferred();
    const h = setup(async () => {
      cleanupEntered.resolve();
      await cleanupRelease.promise;
    });
    try {
      const host = await h.rooms.createRoom({
        displayName: "Host",
        displayNameKey: "host",
        config: CONFIG,
      });
      const socket = await h.connect(host);
      const requestId = h.ids.uuid();
      const acknowledgement = socket.next(
        (message) =>
          message.type === "COMMAND_RESULT" &&
          "requestId" in message.payload &&
          message.payload.requestId === requestId,
      );
      socket.receive({ type: "LEAVE_ROOM", requestId, payload: {} });
      await cleanupEntered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(socket.readyState).toBe(socket.OPEN);
      cleanupRelease.resolve();
      expect((await acknowledgement).payload).toMatchObject({ status: "APPLIED" });
    } finally {
      cleanupRelease.resolve();
      await h.dispose();
    }
  });

  it("still reclaims a CLOSED Room and expires its tombstone if a snapshot subscriber throws", async () => {
    const h = setup();
    try {
      const host = await h.rooms.createRoom({
        displayName: "Host",
        displayNameKey: "host",
        config: CONFIG,
      });
      h.rooms.subscribe((snapshot) => {
        if (snapshot.status === "CLOSED") throw new Error("snapshot transport failed");
      });
      await h.rooms
        .submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "TEST_CLOSED" })
        .catch(() => undefined);
      expect(h.rooms.runtimeCounts().registered).toBe(0);
      h.clock.advance(CLOSED_ROOM_RETENTION_MS);
      expect(h.rooms.getTombstone(host.roomId)).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it("acknowledges the last in-game withdrawal when the Tournament closes the Room before membership cleanup", async () => {
    const h = setup();
    try {
      const { host, sockets, tournamentId } = await h.startTable();
      const view = h.tournaments.getView(tournamentId)!;
      const firstPlayerId = view.seatToPlayer.get(view.engineState.hand!.currentActor!)!;
      const otherPlayerId = [...sockets.keys()].find((playerId) => playerId !== firstPlayerId)!;
      await h.tournaments.submit(tournamentId, {
        type: "SUBMIT_ACTION",
        playerId: firstPlayerId,
        requestId: h.ids.uuid(),
        actionId: h.ids.uuid(),
        expectedSequence: String(view.lastWireSequence),
        action: { type: "ALL_IN" },
        receivedAt: h.clock.now(),
        ingressOrdinal: 1,
      });
      for (const playerId of [firstPlayerId, otherPlayerId]) {
        const socket = sockets.get(playerId)!;
        const requestId = h.ids.uuid();
        const acknowledgement = socket.next(
          (message) =>
            message.type === "COMMAND_RESULT" &&
            "requestId" in message.payload &&
            message.payload.requestId === requestId,
        );
        socket.receive({ type: "LEAVE_ROOM", requestId, payload: {} });
        expect((await acknowledgement).payload).toMatchObject({ status: "APPLIED" });
      }
      await h.drainRooms();
      expect(h.rooms.getSnapshot(host.roomId)).toBeUndefined();
      expect(h.rooms.getTombstone(host.roomId)?.closedReason).toBe("ABANDONED_NO_HUMAN");
      expect(h.tournaments.runtimeCounts().registered).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("revokes every room socket when one final Snapshot send fails", async () => {
    const h = setup();
    try {
      const { host, sockets } = await h.startTable();
      sockets.get(host.playerId)!.failClosedSnapshot = true;
      await h.rooms.submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "TEST_CLOSED" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect([...sockets.values()].map((socket) => socket.readyState)).toEqual([3, 3]);
      expect(h.rooms.runtimeCounts().registered).toBe(0);
      expect(h.tournaments.runtimeCounts().registered).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("returns the authoritative CLOSED Snapshot for the last HTTP withdrawal and retains no token-bearing cache", async () => {
    const h = setup();
    const idempotency = new IdempotencyStore();
    const app = buildApp({
      config: parseAppConfig({ TOKEN_HMAC_SECRET: "tex52-race-http-token-secret-32-characters" }),
      roomManager: h.rooms,
      tournamentManager: h.tournaments,
      now: h.clock.now,
      lobbyGatewayClock: h.clock,
      ids: h.ids,
      idempotency,
    });
    try {
      const { host, guest, tournamentId } = await h.startTable();
      const view = h.tournaments.getView(tournamentId)!;
      const actorId = view.seatToPlayer.get(view.engineState.hand!.currentActor!)!;
      const first = [host, guest].find((session) => session.playerId === actorId)!;
      const last = [host, guest].find((session) => session.playerId !== actorId)!;
      await h.tournaments.submit(tournamentId, {
        type: "SUBMIT_ACTION",
        playerId: actorId,
        requestId: h.ids.uuid(),
        actionId: h.ids.uuid(),
        expectedSequence: String(view.lastWireSequence),
        action: { type: "ALL_IN" },
        receivedAt: h.clock.now(),
        ingressOrdinal: 1,
      });
      let lastRequestId = "";
      for (const session of [first, last]) {
        lastRequestId = h.ids.uuid();
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/rooms/${host.roomId}/leave`,
          headers: {
            authorization: `Bearer ${session.playerToken}`,
            "idempotency-key": lastRequestId,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.roomSnapshot.status).toBe(
          session === last ? "CLOSED" : "IN_GAME",
        );
      }
      await h.drainRooms();
      expect(h.rooms.getSnapshot(host.roomId)).toBeUndefined();
      expect(idempotency.size).toBe(0);
      const retryAfterClose = await app.inject({
        method: "POST",
        url: `/api/v1/rooms/${host.roomId}/leave`,
        headers: { authorization: `Bearer ${last.playerToken}`, "idempotency-key": lastRequestId },
        payload: {},
      });
      expect(retryAfterClose.statusCode).toBe(404);
      expect(retryAfterClose.json().error.code).toBe("ROOM_NOT_FOUND");
    } finally {
      await app.close();
      await h.dispose();
    }
  });
});
