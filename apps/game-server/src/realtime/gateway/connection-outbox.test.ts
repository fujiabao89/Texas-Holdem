import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type GameEventMessage,
  type GameSnapshot,
  type ServerMessage,
} from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../../tests/support/fake-clock";
import { createConnectionOutbox, SEND_LIMITS } from "./connection-outbox";
import { createGameDiagnostics } from "../../observability/game-diagnostics";
import { createServerMetrics, N } from "../../observability/server-metrics";

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

function harness(
  options: {
    now?: () => number;
    onRecovered?: (snapshot: GameSnapshot, elapsedMs: number) => void;
  } = {},
) {
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
  const onRecovered = vi.fn(options.onRecovered);
  const getSnapshot = vi.fn(() => snapshot());
  const outbox = createConnectionOutbox({
    socket,
    now: options.now ?? clock.now,
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
  it.each(["events", "age"] as const)(
    "keeps the original recovery deadline while queued %s pressure remains below the byte limit",
    (trigger) => {
      const h = harness();
      h.outbox.send(reply);
      for (let i = 1; i <= SEND_LIMITS.events; i++) h.outbox.send(event(i));
      h.complete(); // RESYNC_REQUIRED
      h.complete(); // Hold the recovery snapshot's completion callback.

      const queued = Array.from({ length: trigger === "events" ? SEND_LIMITS.events : 1 }, (_, i) =>
        event(101 + i),
      );
      expect(
        queued.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0),
      ).toBeLessThan(SEND_LIMITS.softBytes);
      for (const message of queued) h.outbox.send(message);
      const elapsedMs = trigger === "events" ? 1_000 : SEND_LIMITS.ageMs;
      h.clock.advance(elapsedMs);
      h.getSnapshot.mockReturnValue(snapshot(queued.at(-1)!.payload.sequence));
      h.complete(); // New pressure requires another recovery, retaining the original start time.
      expect(h.onResync.mock.calls.map(([reason]) => reason)).toEqual(["events", trigger]);
      h.complete(); // Hold the next recovery snapshot until the original deadline.

      h.clock.advance(SEND_LIMITS.recoveryMs - elapsedMs - SEND_LIMITS.pollMs);
      expect(h.close).not.toHaveBeenCalled();
      h.clock.advance(SEND_LIMITS.pollMs);
      expect(h.close).toHaveBeenCalledExactlyOnceWith("recovery_timeout");
      const sentCount = h.sent.length;
      h.complete();
      expect(h.sent).toHaveLength(sentCount);
      expect(h.clock.pendingTimers()).toBe(0);
    },
  );

  it("keeps the original recovery deadline while control bytes remain above the soft limit", () => {
    const h = harness();
    h.outbox.send({
      type: "GAME_SNAPSHOT",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 0,
      payload: snapshot("0"),
    });
    h.complete();
    h.outbox.send(reply); // Hold one control write while a bounded backlog accumulates.
    const control: ServerMessage = {
      type: "TIME_SYNC_RESULT",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 0,
      payload: {
        requestId: "00000000-0000-4000-8000-000000000010",
        clientSentAt: 0,
        serverReceivedAt: 0,
        serverSentAt: 0,
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(control));
    for (let i = 0; i <= Math.ceil(SEND_LIMITS.softBytes / bytes); i++) h.outbox.send(control);
    h.clock.advance(5_000);
    h.complete(); // RESYNC_REQUIRED
    h.complete(); // GAME_SNAPSHOT
    h.complete(); // Snapshot complete, but the original control backlog still exceeds 256 KiB.
    h.clock.advance(24_900);
    expect(h.close).not.toHaveBeenCalled();
    h.clock.advance(100);
    expect(h.close).toHaveBeenCalledExactlyOnceWith("recovery_timeout");
    h.complete();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("delivers the latest same-sequence snapshot received after a recovery write started", () => {
    const h = harness();
    h.outbox.send(reply);
    for (let i = 1; i <= 64; i++) h.outbox.send(event(i));
    h.complete();
    h.complete(); // The old recovery snapshot is now immutable and in flight.
    h.outbox.send({
      type: "GAME_SNAPSHOT",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 1,
      payload: { ...snapshot(), currentActorPlayerId: "p1", actionDeadline: 42_000 },
    });
    h.outbox.send({
      type: "GAME_SNAPSHOT",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: 2,
      payload: { ...snapshot(), currentActorPlayerId: "p1", actionDeadline: 50_000 },
    });
    h.outbox.send(event(100));
    h.outbox.send(event(101));
    h.complete();
    expect(h.sent.at(-1)).toMatchObject({
      type: "GAME_SNAPSHOT",
      payload: { sequence: "100", currentActorPlayerId: "p1", actionDeadline: 50_000 },
    });
    h.complete();
    expect(h.sent.at(-1)).toMatchObject({ type: "GAME_EVENT", payload: { sequence: "101" } });
    expect(h.sent.filter((message) => message.type === "GAME_SNAPSHOT")).toHaveLength(2);
    h.complete();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("continues asynchronous recovery and draining when wall time rolls back during the snapshot write", () => {
    let wallMs = 10_000;
    const metrics = createServerMetrics();
    const diagnose = createGameDiagnostics(
      metrics,
      { version: "test", deploymentSha: null },
      () => {},
    );
    const h = harness({
      now: () => wallMs,
      onRecovered: (value, elapsed) =>
        diagnose({
          event: "SNAPSHOT_SENT",
          trigger: "BACKPRESSURE",
          roomId: "r1",
          tournamentId: "t1",
          handId: value.handId,
          playerId: "p1",
          eventSequence: value.sequence,
          timestamp: wallMs,
          delayMs: elapsed,
        }),
    });
    h.outbox.send(reply);
    for (let i = 1; i <= 64; i++) h.outbox.send(event(i));
    h.complete();
    h.complete();
    h.outbox.send(reply);
    wallMs = 9_000;
    expect(() => h.complete()).not.toThrow(); // Real asynchronous callback, outside send's try/catch.
    expect(h.sent.at(-1)?.type).toBe("SESSION_REPLACED");
    h.complete();
    expect(metrics.countOf(N.snapshotsSent, { trigger: "BACKPRESSURE" })).toBe(1);
    expect(h.outbox.isIdle()).toBe(true);
    expect(h.clock.pendingTimers()).toBe(0);
  });
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
