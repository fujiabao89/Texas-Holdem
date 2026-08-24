import { describe, expect, it } from "vitest";

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
  send(data: string): void { this.sent.push(data); }
  close(code = 1000): void { this.onclose?.({ code } as CloseEvent); }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
}

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
];

function setup() {
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
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({ type: "AUTHENTICATE", protocolVersion: 1, payload: { roomId: "room-1" } });
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: 1, serverTime: clock.now(), payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });

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
      second.socket.receive({ type: "GAME_SNAPSHOT", protocolVersion: 1, serverTime: 1, payload: { ...gameSnapshot(), ...privateField } });
      expect(second.store.getSnapshot()).toMatchObject({ game: null, actionsDisabled: true, resyncReason: "INVALID_EVENT" });
    }
  });

  it("uses the same snapshot boundary for gaps and stale game state", () => {
    const { socket, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: 1, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    socket.receive({ type: "GAME_EVENT", protocolVersion: 1, serverTime: 2, payload: { tournamentId: "tournament-1", sequence: "9007199254740993", handId: "hand-1", event: { type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } }, patch: {} } });
    socket.receive({ type: "ERROR", protocolVersion: 1, serverTime: 3, payload: { code: "STALE_GAME_STATE", message: "ignored", retryable: false, traceId: "trace-1" } });
    const snapshotRequests = socket.sent.map((entry) => JSON.parse(entry)).filter((entry) => entry.type === "REQUEST_SNAPSHOT");
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests.every((entry) => entry.payload.tournamentId === "tournament-1")).toBe(true);
  });

  it("keeps COMMAND_RESULT out of canonical game state", () => {
    const { socket, store, commandResults, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: 1, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    const before = store.getSnapshot().game;
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: 1, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "APPLIED", duplicate: false, appliedSequence: "9007199254740992" } });
    expect(store.getSnapshot().game).toBe(before);
    expect(commandResults).toEqual([pending.requestId]);
  });

  it("drops pending commands when switching connections so stale results cannot notify a new room", () => {
    const { socket, commandResults, transport } = setup();
    transport.connect("room-1", "a".repeat(43));
    socket.open();
    socket.receive({ type: "RECONNECT_RESULT", protocolVersion: 1, serverTime: 1, payload: { connectionId: "connection-1", resumed: false, tookOver: false, roomSnapshot: roomSnapshot(), gameSnapshot: gameSnapshot() } });
    const pending = transport.prepareSubmitAction("tournament-1", "9007199254740991", { type: "CALL" });
    transport.send(pending);
    transport.connect("room-2", "b".repeat(43));
    socket.receive({ type: "COMMAND_RESULT", protocolVersion: 1, serverTime: 2, payload: { requestId: pending.requestId, actionId: pending.actionId, status: "APPLIED", duplicate: false, appliedSequence: "9007199254740992" } });
    expect(commandResults).toEqual([]);
  });
});
