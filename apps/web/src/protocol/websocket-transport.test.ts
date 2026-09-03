import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@texas-holdem/protocol";

import { createFakeClock } from "../../../../tests/support/fake-clock";
import { gameSnapshot, roomSnapshot } from "../testing-fixtures";
import { ProjectionStore } from "../state/projection-store";
import { PlayerTokenStore } from "./token-store";
import { WebSocketTransport, type WebSocketLike } from "./websocket-transport";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }
  close(code = 1000): void { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
}

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
];

function setup(clock?: ReturnType<typeof createFakeClock>) {
  const socket = new FakeWebSocket();
  const store = new ProjectionStore();
  const states: string[] = [];
  const commandResults: string[] = [];
  const transport = new WebSocketTransport({
    wsUrl: "wss://example.test/api/v1/ws",
    socketFactory: () => socket,
    createUuid: () => ids.shift() ?? "123e4567-e89b-42d3-a456-426614174099",
    projectionStore: store,
    tokenStore: new PlayerTokenStore(),
    clock,
    random: () => 0.5,
    onConnectionState: (state) => states.push(state),
    onCommandResult: (pending) => commandResults.push(pending.requestId),
  });
  return { socket, store, states, commandResults, transport };
}

describe("WebSocketTransport", () => {
  it("sends AUTHENTICATE as its only pre-authentication envelope and reuses a pending command exactly", () => {
    const clock = createFakeClock();
    const { socket, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({ type: "AUTHENTICATE", protocolVersion: PROTOCOL_VERSION, payload: { roomId: "room-1" } });
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: clock.now(), payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });

    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    transport.send(pending);
    expect(socket.sent.slice(-2)).toEqual([pending.serialized, pending.serialized]);
    expect(JSON.parse(pending.serialized)).toMatchObject({ type: "SUBMIT_ACTION", requestId: pending.requestId, payload: { actionId: pending.actionId, expectedSequence: "9007199254740991" } });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("rejects an unsupported version and unknown fields without accepting state", () => {
    const { socket, store, states, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "GAME_SNAPSHOT", protocolVersion: 2, serverTime: 1, payload: gameSnapshot() });
    expect(states).toContain("STOPPED");
    expect(store.getSnapshot().game).toBeNull();

    for (const privateField of [{ deck: [] }, { burnCard: { rank: "2", suit: "CLUBS" } }, { playerToken: "a".repeat(43) }]) {
      const second = setup();
      second.transport.connect("room-1", "a".repeat(43));
      second.socket.open();
      second.socket.receive({ type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { ...gameSnapshot(), ...privateField } });
      expect(second.store.getSnapshot()).toMatchObject({ game: null, actionsDisabled: true, resyncReason: "INVALID_EVENT" });
      expect(second.states).toContain("CLOSED");
    }
  });

  it("keeps a closed socket reconnectable when a presentation recovery request arrives", () => {
    const clock = createFakeClock();
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    const sockets = [first, second];
    const states: string[] = [];
    const transport = new WebSocketTransport({
      wsUrl: "wss://example.test/api/v1/ws",
      socketFactory: () => sockets.shift() ?? second,
      createUuid: () => ids.shift() ?? "123e4567-e89b-42d3-a456-426614174099",
      projectionStore: new ProjectionStore(),
      tokenStore: new PlayerTokenStore(),
      clock,
      random: () => 0.5,
      onConnectionState: (state) => states.push(state),
    });
    transport.connect("room-1", "a".repeat(43));
    first.open();
    first.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    first.close();

    expect(transport.requestAuthoritativeSnapshot()).toBe(false);
    expect(states.at(-1)).toBe("CLOSED");
    transport.reconnectNow();
    expect(states.at(-1)).toBe("CONNECTING");
    second.open();
    expect(JSON.parse(second.sent[0] ?? "")).toMatchObject({ type: "AUTHENTICATE", protocolVersion: PROTOCOL_VERSION });
  });

  it("uses the same snapshot boundary for gaps and stale game state", () => {
    const { socket, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    socket.receive({ type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { tournamentId: "tournament-1", sequence: "9007199254740993", handId: "hand-1", event: { type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } }, patch: {} } });
    socket.receive({ type: "ERROR", protocolVersion: PROTOCOL_VERSION, serverTime: 3, payload: { code: "STALE_GAME_STATE", message: "ignored", retryable: false, traceId: "trace-1" } });
    const snapshotRequests = socket.sent.map((entry) => JSON.parse(entry)).filter((entry) => entry.type === "REQUEST_SNAPSHOT");
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests.every((entry) => entry.payload.tournamentId === "tournament-1")).toBe(true);
  });

  it("keeps COMMAND_RESULT out of canonical game state", () => {
    const { socket, store, commandResults, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    const before = store.getSnapshot().game;
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "APPLIED", duplicate: false, appliedSequence: "9007199254740992" } });
    expect(store.getSnapshot().game).toBe(before);
    expect(commandResults).toEqual([pending.requestId]);
  });

  it("publishes command feedback to the UI while preserving Snapshot/Event as game authority", () => {
    const { socket, store, transport } = setup();
    const feedback: string[] = [];
    transport.subscribeCommandResults((pending, result) => feedback.push(`${pending.status}:${result.status}`));
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    const before = store.getSnapshot().game;
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "REJECTED", duplicate: false, error: { code: "STALE_GAME_STATE", message: "ignored", retryable: true, traceId: "trace-1" } } });
    expect(feedback).toEqual(["REJECTED:REJECTED"]);
    expect(store.getSnapshot().game).toBe(before);
    expect(store.getSnapshot().actionsDisabled).toBe(true);
  });

  it("publishes Session Replaced as a terminal feedback state without changing the last projection", () => {
    const { socket, store, states, transport } = setup();
    const errors: string[] = [];
    transport.subscribeProtocolErrors((code) => errors.push(code));
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const before = store.getSnapshot().game;
    socket.receive({ type: "SESSION_REPLACED", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: {} });
    expect(errors).toEqual(["SESSION_REPLACED"]);
    expect(states).toContain("STOPPED");
    expect(store.getSnapshot().game).toBe(before);
  });

  it("recycles an APPLIED pending action only after its authoritative sequence arrives", () => {
    const { socket, commandResults, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "APPLIED", duplicate: false, appliedSequence: "9007199254740992" } });
    socket.receive({ type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: 3, payload: { tournamentId: "tournament-1", sequence: "9007199254740992", handId: "hand-1", event: { type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } }, patch: { currentActorPlayerId: "player-2", viewer: { legalActions: null } } } });
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 4, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "REJECTED", duplicate: false, error: { code: "INVALID_ACTION", message: "ignored", retryable: false, traceId: "trace-1" } } });
    expect(commandResults).toEqual([pending.requestId]);
  });

  it("drops pending commands when switching connections so stale results cannot notify a new room", () => {
    const { socket, commandResults, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    transport.connect("room-2", "b".repeat(43));
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "APPLIED", duplicate: false, appliedSequence: "9007199254740992" } });
    expect(commandResults).toEqual([]);
  });

  it("ignores callbacks that were queued by a replaced socket", () => {
    const clock = createFakeClock();
    const firstSocket = new FakeWebSocket();
    const secondSocket = new FakeWebSocket();
    const sockets = [firstSocket, secondSocket];
    const store = new ProjectionStore();
    const states: string[] = [];
    const transport = new WebSocketTransport({
      wsUrl: "wss://example.test/api/v1/ws",
      socketFactory: () => sockets.shift() ?? secondSocket,
      createUuid: () => ids.shift() ?? "123e4567-e89b-42d3-a456-426614174099",
      projectionStore: store,
      tokenStore: new PlayerTokenStore(),
      clock,
      random: () => 0.5,
      onConnectionState: (state) => states.push(state),
    });

    transport.connect("room-1", "a".repeat(43));
    firstSocket.open();
    firstSocket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const oldMessage = firstSocket.onmessage;
    const oldClose = firstSocket.onclose;
    const oldError = firstSocket.onerror;

    transport.connect("room-1", "a".repeat(43));
    secondSocket.open();
    secondSocket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { connectionId: "connection-2", resumed: true, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    states.length = 0;

    oldMessage?.({ data: JSON.stringify({ type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: 3, payload: { tournamentId: "tournament-1", sequence: "9007199254740992", handId: "hand-1", event: { type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } }, patch: { currentActorPlayerId: "player-2", viewer: { legalActions: null } } } }) } as MessageEvent<string>);
    oldClose?.({ code: 1006 } as CloseEvent);
    oldError?.({} as Event);

    expect(store.getSnapshot().game?.sequence).toBe("9007199254740991");
    expect(states).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("retains an unresolved command for an exact retry after reconnecting to the same room", () => {
    const { socket, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);

    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { connectionId: "connection-2", resumed: true, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    transport.send(pending);

    expect(socket.sent.slice(-1)).toEqual([pending.serialized]);
  });

  it("resets reconnect backoff after receiving a new snapshot barrier", () => {
    const clock = createFakeClock();
    const { socket, transport } = setup(clock);
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });

    socket.close();
    clock.advance(0);
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { connectionId: "connection-2", resumed: true, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });

    socket.close();
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("retries an unresolved command byte-for-byte after reconnecting", () => {
    const clock = createFakeClock();
    const { socket, transport } = setup(clock);
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    socket.close();
    clock.advance(0);
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { connectionId: "connection-2", resumed: true, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    expect(socket.sent.at(-1)).toBe(pending.serialized);
  });

  it("retries a user-rejected command after it is restored to SENDING", () => {
    const clock = createFakeClock();
    const { socket, transport } = setup(clock);
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "REJECTED", duplicate: false, error: { code: "GAME_UNAVAILABLE", message: "ignored", retryable: true, traceId: "trace-1" } } });
    transport.send({ ...pending, status: "SENDING" });

    const sentBeforeReconnect = socket.sent.length;
    socket.close();
    clock.advance(0);
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 3, payload: { connectionId: "connection-2", resumed: true, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });

    expect(socket.sent.length).toBeGreaterThan(sentBeforeReconnect);
    expect(socket.sent.slice(sentBeforeReconnect)).toContain(pending.serialized);
  });
});
