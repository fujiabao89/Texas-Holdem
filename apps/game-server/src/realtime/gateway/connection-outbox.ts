import { PROTOCOL_VERSION, type GameSnapshot, type ServerMessage } from "@texas-holdem/protocol";
import type { LobbyGatewayClock } from "./lobby-gateway";

export const SEND_LIMITS = {
  events: 64,
  ageMs: 5_000,
  softBytes: 256 * 1024,
  hardBytes: 1024 * 1024,
  recoveryMs: 30_000,
  pollMs: 100,
} as const;

type ResyncTrigger = "events" | "age" | "bytes";
type CloseTrigger = "hard_bytes" | "recovery_timeout" | "transport_error";
interface Frame {
  message: ServerMessage;
  raw: string;
  bytes: number;
  enqueuedAt: number;
}
interface OutboxOptions {
  socket: {
    readonly OPEN: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(raw: string, callback: (error?: Error) => void): void;
  };
  now(): number;
  clock: LobbyGatewayClock;
  snapshot(tournamentId: string): GameSnapshot | null;
  close(reason: CloseTrigger): void;
  onResync(trigger: ResyncTrigger): void;
  onRecovered(snapshot: GameSnapshot, elapsedMs: number): void;
  onWritten(message: ServerMessage, bytes: number, waitedMs: number): void;
  onCompleted(message: ServerMessage): void;
}

/** Per-socket bounded egress. A send callback is transport completion, never a client ACK. */
export function createConnectionOutbox(options: OutboxOptions) {
  let queue: Frame[] = [];
  let queueBytes = 0;
  let busy = false;
  let stopped = false;
  let monitor: unknown | null = null;
  let resyncTournament: string | null = null;
  let recoveryStartedAt: number | null = null;
  let barrier: { tournamentId: string; sequence: bigint } | null = null;
  // Retain at most one unsent authoritative recovery; generate it only once transport can drain.
  let recovering = false;
  let recoverySnapshotInFlight = false;

  const buffered = () => options.socket.bufferedAmount ?? 0;
  function dispose(): void {
    stopped = true;
    queue = [];
    queueBytes = 0;
    resyncTournament = null;
    recoverySnapshotInFlight = false;
    if (monitor !== null) options.clock.clearInterval(monitor);
    monitor = null;
  }
  function close(reason: CloseTrigger): void {
    if (stopped) return;
    dispose();
    options.close(reason);
  }
  function frame(message: ServerMessage): Frame {
    const raw = JSON.stringify(message);
    return { message, raw, bytes: Buffer.byteLength(raw), enqueuedAt: options.now() };
  }
  function removeGameFrames(tournamentId: string): void {
    queue = queue.filter(({ message }) => {
      if (
        message.type === "GAME_EVENT" ||
        message.type === "GAME_SNAPSHOT" ||
        message.type === "CLOCK_UPDATED"
      )
        return message.payload.tournamentId !== tournamentId;
      return true;
    });
    queueBytes = queue.reduce((sum, item) => sum + item.bytes, 0);
  }
  function beginResync(tournamentId: string, trigger: ResyncTrigger): void {
    if (resyncTournament === tournamentId || recovering) return;
    removeGameFrames(tournamentId);
    resyncTournament = tournamentId;
    recoveryStartedAt ??= options.now();
    options.onResync(trigger);
  }
  function check(): void {
    if (stopped) return;
    const total = queueBytes + buffered();
    if (total >= SEND_LIMITS.hardBytes) {
      close("hard_bytes");
      return;
    }
    if (recoveryStartedAt !== null && options.now() - recoveryStartedAt >= SEND_LIMITS.recoveryMs) {
      close("recovery_timeout");
      return;
    }
    const events = queue.filter((item) => item.message.type === "GAME_EVENT");
    const oldest = events[0];
    const tournamentId =
      oldest?.message.type === "GAME_EVENT"
        ? oldest.message.payload.tournamentId
        : barrier?.tournamentId;
    const trigger =
      events.length >= SEND_LIMITS.events
        ? "events"
        : oldest !== undefined && options.now() - oldest.enqueuedAt >= SEND_LIMITS.ageMs
          ? "age"
          : total >= SEND_LIMITS.softBytes
            ? "bytes"
            : null;
    if (trigger !== null && tournamentId !== undefined) beginResync(tournamentId, trigger);
    // Lobby-only sockets also stop growing and time out at a sustained soft byte limit.
    if (total >= SEND_LIMITS.softBytes) recoveryStartedAt ??= options.now();
    if (resyncTournament === null && !recovering && !busy && total < SEND_LIMITS.softBytes)
      recoveryStartedAt = null;
  }
  function pump(): void {
    check();
    if (stopped || busy || options.socket.readyState !== options.socket.OPEN) return;
    if (buffered() >= SEND_LIMITS.softBytes) return;
    if (resyncTournament !== null) {
      const tournamentId = resyncTournament;
      const snapshot = options.snapshot(tournamentId);
      if (snapshot === null) {
        close("transport_error");
        return;
      }
      removeGameFrames(tournamentId);
      resyncTournament = null;
      recovering = true;
      const messages: ServerMessage[] = [
        {
          type: "RESYNC_REQUIRED",
          protocolVersion: PROTOCOL_VERSION,
          serverTime: options.now(),
          payload: { tournamentId, reason: "BACKPRESSURE" },
        },
        {
          type: "GAME_SNAPSHOT",
          protocolVersion: PROTOCOL_VERSION,
          serverTime: options.now(),
          payload: snapshot,
        },
      ];
      const frames = messages.map(frame);
      queue.unshift(...frames);
      queueBytes += frames.reduce((sum, item) => sum + item.bytes, 0);
      barrier = { tournamentId, sequence: BigInt(snapshot.sequence) };
      check();
      if (stopped) return;
    }
    let item = queue.shift();
    if (item === undefined) {
      if (recoveryStartedAt === null && monitor !== null) {
        options.clock.clearInterval(monitor);
        monitor = null;
      }
      return;
    }
    queueBytes -= item.bytes;
    if (recovering && item.message.type === "GAME_SNAPSHOT") {
      // RESYNC_REQUIRED may itself wait on I/O. Same-sequence phase changes during
      // that wait must be included even when no further GAME_EVENT was produced.
      const tournamentId = item.message.payload.tournamentId;
      const snapshot = options.snapshot(tournamentId);
      if (snapshot === null) {
        close("transport_error");
        return;
      }
      removeGameFrames(tournamentId);
      item = frame({
        type: "GAME_SNAPSHOT",
        protocolVersion: PROTOCOL_VERSION,
        serverTime: options.now(),
        payload: snapshot,
      });
      barrier = { tournamentId, sequence: BigInt(snapshot.sequence) };
    }
    if (queueBytes + buffered() + item.bytes >= SEND_LIMITS.hardBytes) {
      close("hard_bytes");
      return;
    }
    busy = true;
    const writing = item;
    recoverySnapshotInFlight = recovering && writing.message.type === "GAME_SNAPSHOT";
    try {
      options.socket.send(writing.raw, (error) => {
        busy = false;
        recoverySnapshotInFlight = false;
        if (stopped) return;
        if (error != null) {
          close("transport_error");
          return;
        }
        if (recovering && writing.message.type === "GAME_SNAPSHOT") {
          recovering = false;
          const elapsed = options.now() - (recoveryStartedAt ?? options.now());
          options.onRecovered(writing.message.payload, elapsed);
        } else options.onCompleted(writing.message);
        pump();
      });
      options.onWritten(writing.message, writing.bytes, options.now() - writing.enqueuedAt);
    } catch {
      close("transport_error");
    }
  }
  function send(message: ServerMessage): void {
    if (stopped || options.socket.readyState !== options.socket.OPEN) return;
    if (message.type === "GAME_EVENT") {
      if (resyncTournament === message.payload.tournamentId) return;
      if (
        barrier?.tournamentId === message.payload.tournamentId &&
        BigInt(message.payload.sequence) <= barrier.sequence
      )
        return;
    }
    if (message.type === "GAME_SNAPSHOT") {
      // Before the recovery snapshot's write boundary it will be regenerated.
      // Once written, retain/coalesce later authority behind the immutable frame.
      if (
        resyncTournament === message.payload.tournamentId ||
        (recovering && !recoverySnapshotInFlight)
      )
        return;
      barrier = {
        tournamentId: message.payload.tournamentId,
        sequence: BigInt(message.payload.sequence),
      };
      removeGameFrames(message.payload.tournamentId);
    }
    if (message.type === "RECONNECT_RESULT" && message.payload.gameSnapshot !== null) {
      const snapshot = message.payload.gameSnapshot;
      barrier = { tournamentId: snapshot.tournamentId, sequence: BigInt(snapshot.sequence) };
    }
    const item = frame(message);
    // Check before retaining a frame, including control replies and Room snapshots.
    if (queueBytes + buffered() + item.bytes >= SEND_LIMITS.hardBytes) {
      close("hard_bytes");
      return;
    }
    queue.push(item);
    queueBytes += item.bytes;
    if (monitor === null) monitor = options.clock.setInterval(pump, SEND_LIMITS.pollMs);
    pump();
    if (
      queue.length === 0 &&
      !busy &&
      resyncTournament === null &&
      recoveryStartedAt === null &&
      monitor !== null
    ) {
      options.clock.clearInterval(monitor);
      monitor = null;
    }
  }
  function endMembership(): void {
    queue = queue.filter(
      ({ message }) =>
        message.type !== "GAME_EVENT" &&
        message.type !== "GAME_SNAPSHOT" &&
        message.type !== "CLOCK_UPDATED" &&
        message.type !== "RESYNC_REQUIRED",
    );
    queueBytes = queue.reduce((sum, item) => sum + item.bytes, 0);
    resyncTournament = null;
    recovering = false;
    recoverySnapshotInFlight = false;
    barrier = null;
  }
  return {
    send,
    dispose,
    endMembership,
    isIdle: () => !busy && queue.length === 0 && resyncTournament === null,
  };
}
