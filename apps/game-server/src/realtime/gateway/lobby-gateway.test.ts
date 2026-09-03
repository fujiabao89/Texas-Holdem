import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import { PROTOCOL_VERSION, type ClockUpdatedPayload, type GameEventMessage, type TournamentConfig } from "@texas-holdem/protocol";

import { IdempotencyStore } from "../../http/middleware/idempotency";
import type { IdSource } from "../../rooms/id-source";
import { createRoomManager, type RoomManager } from "../../rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "../../rooms/test-support";
import type { TournamentCommand } from "../../tournaments/tournament-commands";
import { TournamentDomainError } from "../../tournaments/tournament-errors";
import { TournamentExecutor, type TournamentOutputSink } from "../../tournaments/tournament-executor";
import type { TournamentManager } from "../../tournaments/tournament-manager";
import { createTournamentRuntimeState } from "../../tournaments/tournament-runtime";
import { createFakeClock } from "../../../../../tests/support/fake-clock";
import { createTournamentEventBus } from "../tournament-event-bus";
import { createConnectionEpochRegistry } from "../connection-epochs";
import { registerLobbyGateway } from "./lobby-gateway";

const config: TournamentConfig = {
  maxPlayers: 4,
  startingStack: 1_000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 60,
};

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  pings = 0;
  terminated = false;
  readonly closeCodes: number[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000): void {
    this.closeCodes.push(code);
    this.readyState = 3;
    this.emit("close");
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006);
  }

  receive(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  pong(): void {
    this.emit("pong");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function fakeIds(clock: ReturnType<typeof createFakeClock>): IdSource {
  let next = 0;
  let random = 0;
  return {
    uuid: () => `id-${++next}`,
    randomBytes: (count) => Uint8Array.from({ length: count }, () => (random++ % 248)),
    now: clock.now,
  };
}

function setup() {
  const clock = createFakeClock();
  const ids = fakeIds(clock);
  const manager = createRoomManager({
    persistence: fakePersistence(),
    roomRepository: fakeRoomRepository(),
    ids,
    tokenSecret: "test-secret",
    tokenKeyId: "k1",
  });
  let handler!: (socket: FakeSocket) => void;
  const app = {
    get(_path: string, _options: unknown, route: unknown) {
      handler = route as (socket: FakeSocket) => void;
    },
  } as unknown as FastifyInstance;
  registerLobbyGateway(app, manager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock });
  return { clock, manager, handler: (socket: FakeSocket) => handler(socket) };
}

/** A real TEX-20 runtime behind a controlled Room projection for WS-only routing tests. */
async function setupTournamentGateway() {
  const clock = createFakeClock({ now: 1_000 });
  const ids = fakeIds(clock);
  const manager = createRoomManager({
    persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids, tokenSecret: "test-secret", tokenKeyId: "k1",
  });
  const host = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
  const member = await manager.joinRoom({ inviteCode: host.roomSnapshot.inviteCode!, displayName: "Alice", displayNameKey: "alice" });
  const emittedEvents: GameEventMessage[] = [];
  const emittedClocks: ClockUpdatedPayload[] = [];
  const output: TournamentOutputSink = {
    emitEvents(messages) { emittedEvents.push(...messages); },
    emitClockUpdated(payload) { emittedClocks.push(payload); },
    enqueueCommitBundles() {},
    submitRoomCommand() {},
  };
  const runtime = createTournamentRuntimeState({
    tournamentId: "t1",
    roomId: host.roomId,
    config,
    players: [
      { playerId: host.playerId, tournamentPlayerId: "tp-host", displayName: "Host", seatIndex: 0, kind: "HUMAN", startingStack: config.startingStack },
      { playerId: member.playerId, tournamentPlayerId: "tp-member", displayName: "Alice", seatIndex: 1, kind: "HUMAN", startingStack: config.startingStack },
    ],
    rng: new SeededRandomSource(42),
    engineOptions: { firstDealerSeat: 0 },
  }, { clock: clock.now, ids, scheduler: clock });
  const executor = new TournamentExecutor(runtime, { output });
  await executor.submit({ type: "START" });
  const submitted: TournamentCommand[] = [];
  let rejectTimeBank = false;
  const tournaments: TournamentManager = {
    create() {},
    createRecovered() {},
    createRecoveredFresh() {},
    async submit(_tournamentId, command) {
      submitted.push(command);
      if (command.type === "USE_TIME_BANK" && rejectTimeBank) throw new TournamentDomainError("NOT_YOUR_TURN");
      return "requestId" in command
        ? { requestId: command.requestId, actionId: command.type === "SUBMIT_ACTION" ? command.actionId : undefined, status: "APPLIED", duplicate: false }
        : null;
    },
    getView(tournamentId) { return tournamentId === "t1" ? executor.getView() : undefined; },
    async setConnection() {},
    async pauseAll() {},
    activeTournamentIds() { return []; },
  };
  const gatewayManager: RoomManager = {
    ...manager,
    getSnapshot(roomId) {
      const snapshot = manager.getSnapshot(roomId);
      return snapshot === undefined ? undefined : { ...snapshot, status: "IN_GAME", activeTournamentId: "t1" };
    },
  };
  const events = createTournamentEventBus();
  let handler!: (socket: FakeSocket) => void;
  const app = { get(_path: string, _options: unknown, route: unknown) { handler = route as (socket: FakeSocket) => void; } } as unknown as FastifyInstance;
  registerLobbyGateway(app, gatewayManager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock, tournaments, events });
  return {
    clock, manager, host, member, handler: (socket: FakeSocket) => handler(socket), tournaments, submitted, events, emittedEvents, emittedClocks, executor,
    rejectTimeBank: () => { rejectTimeBank = true; },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function authenticate(socket: FakeSocket, roomId: string, playerToken: string, requestId = "00000000-0000-4000-8000-000000000001"): void {
  socket.receive({ type: "AUTHENTICATE", protocolVersion: PROTOCOL_VERSION, requestId, payload: { roomId, playerToken } });
}

describe("LobbyGateway", () => {
  it("rejects a Lobby mutation queued by an old socket after a takeover", async () => {
    const clock = createFakeClock();
    const ids = fakeIds(clock);
    const epochs = createConnectionEpochRegistry();
    const manager = createRoomManager({
      persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids, tokenSecret: "test-secret", tokenKeyId: "k1", isConnectionCurrent: epochs.isCurrent,
    });
    let releaseOldMutation: (() => void) | undefined;
    const delayedManager: RoomManager = {
      ...manager,
      submitCommand(roomId, command) {
        if (command.type === "SET_READY" && command.connectionEpoch !== undefined) {
          return new Promise((resolve, reject) => {
            releaseOldMutation = () => { void manager.submitCommand(roomId, command).then(resolve, reject); };
          });
        }
        return manager.submitCommand(roomId, command);
      },
    };
    let handler!: (socket: FakeSocket) => void;
    const app = { get(_path: string, _options: unknown, route: unknown) { handler = route as (socket: FakeSocket) => void; } } as unknown as FastifyInstance;
    registerLobbyGateway(app, delayedManager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock, epochs });
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const oldSocket = new FakeSocket();
    handler(oldSocket);
    authenticate(oldSocket, session.roomId, session.playerToken);
    await flush();

    oldSocket.receive({ type: "SET_READY", requestId: "00000000-0000-4000-8000-000000000020", payload: { ready: true } });
    await flush();
    const replacement = new FakeSocket();
    handler(replacement);
    authenticate(replacement, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000021");
    await flush();
    releaseOldMutation?.();
    await flush();

    expect(manager.getSnapshot(session.roomId)?.players[0]?.ready).toBe(false);
  });

  it("marks a normal reconnect as resumed after the first authenticated connection closes", async () => {
    const { manager, handler } = setup();
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const first = new FakeSocket();
    handler(first);
    authenticate(first, session.roomId, session.playerToken);
    await flush();
    first.close();
    await flush();

    const second = new FakeSocket();
    handler(second);
    authenticate(second, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000017");
    await flush();
    expect(second.sent).toContainEqual(expect.objectContaining({ type: "RECONNECT_RESULT", payload: expect.objectContaining({ resumed: true }) }));
  });

  it("projects Time Bank clock data per receiving player and removes an in-game leaver from Room membership", async () => {
    const { host, member, handler, submitted, events, emittedClocks, executor, manager } = await setupTournamentGateway();
    const hostSocket = new FakeSocket();
    const memberSocket = new FakeSocket();
    handler(hostSocket);
    authenticate(hostSocket, host.roomId, host.playerToken);
    await flush();
    handler(memberSocket);
    authenticate(memberSocket, member.roomId, member.playerToken, "00000000-0000-4000-8000-000000000018");
    await flush();

    const view = executor.getView();
    const actorSeat = view.engineState.hand!.currentActor!;
    const actorPlayerId = view.seatToPlayer.get(actorSeat)!;
    await executor.submit({
      type: "USE_TIME_BANK",
      requestId: "clock-per-viewer",
      playerId: actorPlayerId,
      expectedSequence: String(view.lastWireSequence),
      receivedAt: 1_000,
    });
    events.emitClockUpdated(emittedClocks.at(-1)!);

    const clockFor = (socket: FakeSocket) => socket.sent.filter((message) => (message as { type: string }).type === "CLOCK_UPDATED").at(-1) as { payload: { timeBankRemainingMs: number } };
    expect(memberSocket.sent.map((message) => (message as { type: string }).type)).toContain("CLOCK_UPDATED");
    expect(clockFor(actorPlayerId === host.playerId ? hostSocket : memberSocket).payload.timeBankRemainingMs).toBe(30_000);
    expect(clockFor(actorPlayerId === host.playerId ? memberSocket : hostSocket).payload.timeBankRemainingMs).toBe(60_000);

    hostSocket.receive({ type: "LEAVE_ROOM", requestId: "00000000-0000-4000-8000-000000000019", payload: {} });
    await flush();
    expect(submitted).toContainEqual(expect.objectContaining({ type: "WITHDRAW_PLAYER", playerId: host.playerId, connectionEpoch: expect.any(Number) }));
    expect(manager.getSnapshot(host.roomId)?.players.some((player) => player.playerId === host.playerId)).toBe(false);
    expect(() => manager.authenticate(host.roomId, host.playerToken)).toThrowError("AUTH_FAILED");
  });

  it("does not let a superseded in-game leave remove the replacement session's Room membership", async () => {
    const clock = createFakeClock();
    const ids = fakeIds(clock);
    const epochs = createConnectionEpochRegistry();
    const manager = createRoomManager({
      persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids, tokenSecret: "test-secret", tokenKeyId: "k1", isConnectionCurrent: epochs.isCurrent,
    });
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    let releaseRoomLeave: (() => void) | undefined;
    const activeTournamentManager: RoomManager = {
      ...manager,
      getSnapshot(roomId) {
        const snapshot = manager.getSnapshot(roomId);
        return snapshot === undefined ? undefined : { ...snapshot, status: "IN_GAME", activeTournamentId: "t1" };
      },
      submitCommand(roomId, command) {
        if (command.type === "LEAVE" && command.afterTournamentWithdrawal) {
          return new Promise((resolve, reject) => {
            releaseRoomLeave = () => { void manager.submitCommand(roomId, command).then(resolve, reject); };
          });
        }
        return manager.submitCommand(roomId, command);
      },
    };
    const tournaments: TournamentManager = {
      create() {},
      createRecovered() {},
    createRecoveredFresh() {},
      async submit() { return null; },
      getView() { return undefined; },
      async setConnection() {},
      async pauseAll() {},
    activeTournamentIds() { return []; },
    };
    let handler!: (socket: FakeSocket) => void;
    const app = { get(_path: string, _options: unknown, route: unknown) { handler = route as (socket: FakeSocket) => void; } } as unknown as FastifyInstance;
    registerLobbyGateway(app, activeTournamentManager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock, tournaments, epochs });

    const oldSocket = new FakeSocket();
    handler(oldSocket);
    authenticate(oldSocket, session.roomId, session.playerToken);
    await flush();
    oldSocket.receive({ type: "LEAVE_ROOM", requestId: "00000000-0000-4000-8000-000000000022", payload: {} });
    await flush();
    expect(releaseRoomLeave).toBeDefined();

    const replacement = new FakeSocket();
    handler(replacement);
    authenticate(replacement, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000023");
    await flush();
    releaseRoomLeave?.();
    await flush();

    expect(manager.getSnapshot(session.roomId)?.players.some((player) => player.playerId === session.playerId)).toBe(true);
    expect(manager.authenticate(session.roomId, session.playerToken)).toBe(session.playerId);
  });

  it("routes runtime commands with the active epoch and restores only authority snapshots/events", async () => {
    const { host, handler, submitted, events, emittedEvents, executor, rejectTimeBank, manager } = await setupTournamentGateway();
    const socket = new FakeSocket();
    handler(socket);
    authenticate(socket, host.roomId, host.playerToken);
    await flush();

    const reconnect = socket.sent.find((message) => (message as { type: string }).type === "RECONNECT_RESULT") as {
      payload: { gameSnapshot: { tournamentId: string; sequence: string } | null };
    };
    expect(reconnect.payload.gameSnapshot).toMatchObject({ tournamentId: "t1" });
    const sequence = reconnect.payload.gameSnapshot!.sequence;

    socket.receive({ type: "SUBMIT_ACTION", requestId: "00000000-0000-4000-8000-000000000013", payload: { tournamentId: "t1", actionId: "00000000-0000-4000-8000-000000000014", expectedSequence: sequence, action: { type: "CALL" } } });
    await flush();
    expect(submitted.at(-1)).toMatchObject({ type: "SUBMIT_ACTION", playerId: host.playerId, expectedSequence: sequence, connectionEpoch: expect.any(Number) });

    rejectTimeBank();
    socket.receive({ type: "USE_TIME_BANK", requestId: "00000000-0000-4000-8000-000000000015", payload: { tournamentId: "t1", expectedSequence: sequence } });
    await flush();
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "COMMAND_RESULT", payload: expect.objectContaining({ error: expect.objectContaining({ code: "NOT_YOUR_TURN" }) }) }));

    socket.receive({ type: "REQUEST_SNAPSHOT", requestId: "00000000-0000-4000-8000-000000000016", payload: { tournamentId: "t1", lastSequence: sequence, reason: "GAP" } });
    await flush();
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "GAME_SNAPSHOT", payload: expect.objectContaining({ reason: "RESYNC", tournamentId: "t1" }) }));

    const event = emittedEvents.find((message) => message.payload.patch.viewer?.playerId === host.playerId)!;
    events.emitEvents([event]);
    const runtimeView = executor.getView();
    const actorSeat = runtimeView.engineState.hand?.currentActor ?? null;
    events.emitClockUpdated({
      tournamentId: "t1",
      handId: runtimeView.currentHandId,
      currentActorPlayerId: actorSeat === null ? null : runtimeView.seatToPlayer.get(actorSeat) ?? null,
      actionDeadline: runtimeView.actionDeadline,
      timeBankRemainingMs: runtimeView.timeBankRemainingMs.get(host.playerId) ?? 0,
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "GAME_EVENT", payload: expect.objectContaining({ tournamentId: "t1" }) }));
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "CLOCK_UPDATED", payload: expect.objectContaining({ tournamentId: "t1" }) }));

    const gameSnapshotsBeforeRoomUpdate = socket.sent.filter((message) => (message as { type: string }).type === "GAME_SNAPSHOT").length;
    await manager.submitCommand(host.roomId, { type: "SET_READY", playerId: host.playerId, ready: true });
    await flush();
    expect(socket.sent.filter((message) => (message as { type: string }).type === "GAME_SNAPSHOT")).toHaveLength(gameSnapshotsBeforeRoomUpdate);
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "ROOM_SNAPSHOT" }));
  });

  it("claims the epoch before awaited CONNECTED so an old close cannot queue a stale disconnect", async () => {
    const clock = createFakeClock();
    const ids = fakeIds(clock);
    const manager = createRoomManager({
      persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids, tokenSecret: "test-secret", tokenKeyId: "k1",
    });
    let holdConnected = false;
    let releaseConnected: (() => void) | undefined;
    const delayedManager: RoomManager = {
      ...manager,
      submitCommand(roomId, command) {
        const submitted = manager.submitCommand(roomId, command);
        if (holdConnected && command.type === "SET_CONNECTION_STATUS" && command.connectionStatus === "CONNECTED") {
          return submitted.then((result) => new Promise<typeof result>((resolve) => { releaseConnected = () => resolve(result); }));
        }
        return submitted;
      },
    };
    let handler!: (socket: FakeSocket) => void;
    const app = { get(_path: string, _options: unknown, route: unknown) { handler = route as (socket: FakeSocket) => void; } } as unknown as FastifyInstance;
    registerLobbyGateway(app, delayedManager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock });
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });

    const oldSocket = new FakeSocket();
    handler(oldSocket);
    authenticate(oldSocket, session.roomId, session.playerToken);
    await flush();

    holdConnected = true;
    const newSocket = new FakeSocket();
    handler(newSocket);
    authenticate(newSocket, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000012");
    await flush();
    // This is the formerly-racy interleaving: close fires after the new CONNECTED
    // is queued but before that authentication await resumes.
    oldSocket.close();
    releaseConnected?.();
    await flush();

    expect(newSocket.readyState).toBe(newSocket.OPEN);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("CONNECTED");
  });

  it("replaces the stale connection without disconnecting the current one", async () => {
    const { manager, handler } = setup();
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const first = new FakeSocket();
    const second = new FakeSocket();
    handler(first);
    authenticate(first, session.roomId, session.playerToken);
    await flush();
    handler(second);
    authenticate(second, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000002");
    await flush();

    expect(first.sent.some((message) => (message as { type: string }).type === "SESSION_REPLACED")).toBe(true);
    expect(first.closeCodes).toContain(4001);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("CONNECTED");

    first.receive({ type: "SET_READY", requestId: "00000000-0000-4000-8000-000000000003", payload: { ready: true } });
    await flush();
    expect(manager.getSnapshot(session.roomId)?.players[0]?.ready).toBe(false);

    first.receive({ type: "LEAVE_ROOM", requestId: "00000000-0000-4000-8000-000000000009", payload: {} });
    await flush();
    expect(manager.getSnapshot(session.roomId)?.players).toHaveLength(1);
  });

  it("does not let a timed-out authentication take over or leave a phantom connection", async () => {
    const clock = createFakeClock();
    const ids = fakeIds(clock);
    const manager = createRoomManager({
      persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids, tokenSecret: "test-secret", tokenKeyId: "k1",
    });
    let blockConnectionUpdate = false;
    const releaseConnectionUpdates: Array<() => void> = [];
    const delayedManager: RoomManager = {
      ...manager,
      submitCommand(roomId, command) {
        if (blockConnectionUpdate && command.type === "SET_CONNECTION_STATUS" && command.connectionStatus === "CONNECTED") {
          return manager.submitCommand(roomId, command).then((result) => new Promise<typeof result>((resolve) => {
            releaseConnectionUpdates.push(() => resolve(result));
          }));
        }
        return manager.submitCommand(roomId, command);
      },
    };
    let handler!: (socket: FakeSocket) => void;
    const app = { get(_path: string, _options: unknown, route: unknown) { handler = route as (socket: FakeSocket) => void; } } as unknown as FastifyInstance;
    registerLobbyGateway(app, delayedManager, { now: clock.now, ids, idempotency: new IdempotencyStore(), clock });
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const active = new FakeSocket();
    handler(active);
    authenticate(active, session.roomId, session.playerToken);
    await flush();

    blockConnectionUpdate = true;
    const timedOut = new FakeSocket();
    handler(timedOut);
    authenticate(timedOut, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000005");
    await flush();
    clock.advance(5_000);
    releaseConnectionUpdates.shift()!();
    await flush();
    clock.advance(15_000);

    expect(timedOut.closeCodes).toContain(4003);
    expect(timedOut.pings).toBe(0);
    expect(active.readyState).toBe(active.OPEN);
    expect(active.sent.some((message) => (message as { type: string }).type === "SESSION_REPLACED")).toBe(false);

    active.close();
    await flush();
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("DISCONNECTED");

    const orphaned = new FakeSocket();
    handler(orphaned);
    authenticate(orphaned, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000006");
    await flush();
    clock.advance(5_000);
    releaseConnectionUpdates.shift()!();
    await flush();

    expect(orphaned.closeCodes).toContain(4003);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("DISCONNECTED");

    const stale = new FakeSocket();
    handler(stale);
    authenticate(stale, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000007");
    await flush();
    clock.advance(5_000);
    const replacement = new FakeSocket();
    handler(replacement);
    authenticate(replacement, session.roomId, session.playerToken, "00000000-0000-4000-8000-000000000008");
    await flush();

    releaseConnectionUpdates.shift()!();
    await flush();
    releaseConnectionUpdates.shift()!();
    await flush();

    expect(stale.closeCodes).toContain(4003);
    expect(replacement.readyState).toBe(replacement.OPEN);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("CONNECTED");
  });

  it("uses requestId plus the complete payload to replay a Lobby mutation", async () => {
    const { manager, handler } = setup();
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const socket = new FakeSocket();
    handler(socket);
    authenticate(socket, session.roomId, session.playerToken);
    await flush();

    const requestId = "00000000-0000-4000-8000-000000000004";
    socket.receive({ type: "SET_READY", requestId, payload: { ready: true } });
    await flush();
    socket.receive({ type: "SET_READY", requestId, payload: { ready: true } });
    await flush();
    socket.receive({ type: "SET_READY", requestId, payload: { ready: false } });
    await flush();

    const results = socket.sent.filter((message) => (message as { type: string }).type === "COMMAND_RESULT") as Array<{ payload: { status: string; duplicate: boolean } }>;
    expect(results.map((message) => message.payload)).toMatchObject([
      { status: "APPLIED", duplicate: false },
      { status: "APPLIED", duplicate: true },
      { status: "REJECTED", duplicate: false },
    ]);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.ready).toBe(true);
  });

  it("revokes the projection subscription when a member is kicked", async () => {
    const { manager, handler } = setup();
    const host = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const member = await manager.joinRoom({ inviteCode: host.roomSnapshot.inviteCode!, displayName: "Alice", displayNameKey: "alice" });
    const socket = new FakeSocket();
    handler(socket);
    authenticate(socket, member.roomId, member.playerToken);
    await flush();

    const snapshot = manager.getSnapshot(host.roomId)!;
    await manager.submitCommand(host.roomId, { type: "KICK_PLAYER", actorPlayerId: host.playerId, targetPlayerId: member.playerId, expectedRevision: Number(snapshot.roomRevision) });
    await flush();

    expect(socket.closeCodes).toContain(4003);
    expect(manager.getSnapshot(host.roomId)?.players.some((player) => player.playerId === member.playerId)).toBe(false);
  });

  it("sends Ping every 15 seconds and terminates a half-open connection at 45 seconds", async () => {
    const { clock, manager, handler } = setup();
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });
    const socket = new FakeSocket();
    handler(socket);
    authenticate(socket, session.roomId, session.playerToken);
    await flush();

    clock.advance(15_000);
    expect(socket.pings).toBe(1);
    clock.advance(30_000);
    await flush();

    expect(socket.terminated).toBe(true);
    expect(manager.getSnapshot(session.roomId)?.players[0]?.connectionStatus).toBe("DISCONNECTED");
  });

  it("rejects protocol/version/token failures and enforces the first-frame deadline", async () => {
    const { clock, manager, handler } = setup();
    const session = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config });

    const timedOut = new FakeSocket();
    handler(timedOut);
    clock.advance(5_000);
    expect(timedOut.closeCodes).toContain(4003);

    const incompatible = new FakeSocket();
    handler(incompatible);
    incompatible.receive({ type: "AUTHENTICATE", protocolVersion: 3, requestId: "00000000-0000-4000-8000-000000000010", payload: { roomId: session.roomId, playerToken: session.playerToken } });
    await flush();
    expect(incompatible.sent).toContainEqual(expect.objectContaining({ type: "ERROR", payload: expect.objectContaining({ code: "UNSUPPORTED_PROTOCOL_VERSION" }) }));
    expect(incompatible.closeCodes).toContain(4000);

    const invalidToken = new FakeSocket();
    handler(invalidToken);
    authenticate(invalidToken, session.roomId, "z".repeat(43), "00000000-0000-4000-8000-000000000011");
    await flush();
    expect(invalidToken.sent).toContainEqual(expect.objectContaining({ type: "ERROR", payload: expect.objectContaining({ code: "AUTH_FAILED" }) }));
    expect(invalidToken.closeCodes).toContain(4003);
  });
});
