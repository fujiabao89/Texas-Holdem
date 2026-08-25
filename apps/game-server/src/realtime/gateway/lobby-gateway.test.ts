import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { TournamentConfig } from "@texas-holdem/protocol";

import { IdempotencyStore } from "../../http/middleware/idempotency";
import type { IdSource } from "../../rooms/id-source";
import { createRoomManager, type RoomManager } from "../../rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "../../rooms/test-support";
import { createFakeClock } from "../../../../../tests/support/fake-clock";
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function authenticate(socket: FakeSocket, roomId: string, playerToken: string, requestId = "00000000-0000-4000-8000-000000000001"): void {
  socket.receive({ type: "AUTHENTICATE", protocolVersion: 1, requestId, payload: { roomId, playerToken } });
}

describe("LobbyGateway", () => {
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
});
