import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type GameEventMessage,
  type GameSnapshot,
  type ServerMessage,
} from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../../tests/support/fake-clock";
import { createConnectionOutbox, SEND_LIMITS } from "./connection-outbox";

// Transport-only fixtures. Recipient projection and strict schemas are tested in lobby-gateway.
const snapshot = (sequence = "100", handId = "h2") =>
  ({
    snapshotVersion: 1,
    reason: "RESYNC",
    tournamentId: "t1",
    sequence,
    handId,
  }) as GameSnapshot;
const event = (sequence: number): GameEventMessage =>
  ({
    type: "GAME_EVENT",
    protocolVersion: PROTOCOL_VERSION,
    serverTime: 0,
    payload: {
      tournamentId: "t1",
      handId: "h1",
      sequence: String(sequence),
      event: { type: "HAND_STARTED", payload: {} },
      patch: {},
    },
  }) as GameEventMessage;
const reply: ServerMessage = {
  type: "SESSION_REPLACED",
  protocolVersion: PROTOCOL_VERSION,
  serverTime: 0,
  payload: {},
};

function harness() {
  const clock = createFakeClock();
  const sent: ServerMessage[] = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(raw: string, callback: (error?: Error) => void) {
      sent.push(JSON.parse(raw));
      callbacks.push(callback);
    },
  };
  const close = vi.fn();
  const onResync = vi.fn();
  const onRecovered = vi.fn();
  const getSnapshot = vi.fn(() => snapshot());
  const outbox = createConnectionOutbox({
    socket,
    now: clock.now,
    clock,
    snapshot: getSnapshot,
    close,
    onResync,
    onRecovered,
    onWritten: vi.fn(),
    onCompleted: vi.fn(),
  });
  const complete = () => callbacks.shift()?.();
  return {
    clock,
    socket,
    sent,
    callbacks,
    close,
    onResync,
    onRecovered,
    getSnapshot,
    outbox,
    complete,
  };
}

describe("TEX-61 bounded per-connection egress", () => {
  it("refreshes same-sequence authority after RESYNC_REQUIRED waits on I/O", () => {
    const h = harness();
    h.outbox.send(reply);
    for (let i = 1; i <= 64; i++) h.outbox.send(event(i));
    h.complete(); // RESYNC_REQUIRED is now in flight.
    h.getSnapshot.mockReturnValue({
      ...snapshot(),
      currentActorPlayerId: "p1",
      actionDeadline: 42_000,
    });
    h.complete(); // Generate the snapshot at its own actual send boundary.
    expect(h.sent.at(-1)).toMatchObject({
      type: "GAME_SNAPSHOT",
      payload: { sequence: "100", currentActorPlayerId: "p1", actionDeadline: 42_000 },
    });
    h.complete();
    expect(h.clock.pendingTimers()).toBe(0);
  });
  it("64 unsent events trigger one resync, regenerate latest barrier, and suppress the rest of an old batch", () => {
    const h = harness();
    h.outbox.send(reply); // Held transport callback; no socket bytes needed to simulate event-count pressure.
    for (let i = 1; i <= 63; i++) h.outbox.send(event(i));
    expect(h.onResync).not.toHaveBeenCalled();
    h.outbox.send(event(64));
    expect(h.onResync).toHaveBeenCalledExactlyOnceWith("events");
    for (let i = 65; i <= 100; i++) h.outbox.send(event(i));
    expect(h.getSnapshot).not.toHaveBeenCalled(); // Latest state is read at drain, not threshold time.
    h.complete();
    expect(h.sent.at(-1)?.type).toBe("RESYNC_REQUIRED");
    h.complete();
    expect(h.sent.at(-1)).toMatchObject({
      type: "GAME_SNAPSHOT",
      payload: { sequence: "100", handId: "h2" },
    });
    h.outbox.send(event(100)); // Late fanout from a batch already covered by the snapshot.
    h.outbox.send(event(101));
    h.complete();
    expect(h.sent.filter((m) => m.type === "GAME_EVENT").map((m) => m.payload.sequence)).toEqual([
      "101",
    ]);
    h.complete();
    expect(h.onRecovered).toHaveBeenCalledOnce();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("oldest unsent event triggers at exactly 5000ms without more ingress", () => {
    const h = harness();
    h.outbox.send(reply);
    h.outbox.send(event(1));
    h.clock.advance(4900);
    expect(h.onResync).not.toHaveBeenCalled();
    h.clock.advance(100);
    expect(h.onResync).toHaveBeenCalledExactlyOnceWith("age");
    h.outbox.dispose();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("queue bytes plus bufferedAmount trigger at 256KiB, and hard limit closes before retaining a frame", () => {
    const h = harness();
    h.outbox.send({
      type: "GAME_SNAPSHOT",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 0,
      payload: snapshot("0"),
    });
    h.complete();
    const message = event(1);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    h.socket.bufferedAmount = SEND_LIMITS.softBytes - bytes;
    h.outbox.send(message);
    expect(h.onResync).toHaveBeenCalledExactlyOnceWith("bytes");
    h.socket.bufferedAmount = SEND_LIMITS.hardBytes;
    h.clock.advance(100);
    expect(h.close).toHaveBeenCalledExactlyOnceWith("hard_bytes");
    const count = h.sent.length;
    for (let i = 0; i < 1000; i++) h.outbox.send(reply);
    expect(h.sent).toHaveLength(count);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("30 seconds without recovery closes even when a send callback stalls with bufferedAmount zero", () => {
    const h = harness();
    h.outbox.send(reply);
    for (let i = 1; i <= 64; i++) h.outbox.send(event(i));
    h.clock.advance(29_900);
    expect(h.close).not.toHaveBeenCalled();
    h.clock.advance(100);
    expect(h.close).toHaveBeenCalledExactlyOnceWith("recovery_timeout");
    h.complete(); // Late callbacks after disposal cannot resume sends.
    expect(h.sent).toHaveLength(1);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("a stalled control-only socket cannot accumulate unbounded replies", () => {
    const h = harness();
    h.socket.bufferedAmount = SEND_LIMITS.softBytes;
    for (let i = 0; i < 20_000; i++) h.outbox.send(reply);
    expect(h.close).toHaveBeenCalledExactlyOnceWith("hard_bytes");
    expect(h.sent).toHaveLength(0);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("transport error is isolated to its outbox and all poll resources are released", () => {
    const slow = harness(),
      healthy = harness();
    slow.outbox.send(reply);
    slow.callbacks.shift()?.(new Error("private transport internals"));
    healthy.outbox.send(reply);
    healthy.complete();
    expect(slow.close).toHaveBeenCalledExactlyOnceWith("transport_error");
    expect(healthy.close).not.toHaveBeenCalled();
    expect(slow.clock.pendingTimers()).toBe(0);
    expect(healthy.clock.pendingTimers()).toBe(0);
  });
  it("Node socket success callbacks may pass null instead of undefined", () => {
    const h = harness();
    h.outbox.send(reply);
    h.callbacks.shift()?.(null as unknown as Error);
    expect(h.close).not.toHaveBeenCalled();
    h.outbox.send(reply);
    h.complete();
    expect(h.sent).toHaveLength(2);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("membership revocation discards old game frames while a final receipt waits for transport completion", () => {
    const h = harness();
    h.outbox.send(reply);
    h.outbox.send(event(1));
    h.outbox.send(reply);
    h.outbox.endMembership();
    expect(h.outbox.isIdle()).toBe(false);
    h.complete();
    expect(h.sent.map((message) => message.type)).toEqual(["SESSION_REPLACED", "SESSION_REPLACED"]);
    h.complete();
    expect(h.outbox.isIdle()).toBe(true);
    expect(h.clock.pendingTimers()).toBe(0);
  });
});
