/**
 * TEX-51：真实 PostgreSQL + 生产 main 子进程的崩溃/重启验收。
 * 只迁移一次隔离 schema，重启保留数据和 HMAC 配置；SIGKILL 确保没有
 * 旧内存、旧连接或优雅关闭替测试补写。等待来自监听日志、WS 帧和提交水位。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  CreateRoomResponseSchema,
  JoinRoomResponseSchema,
  StartTournamentResponseSchema,
  UpdateRoomResponseSchema,
  type GameEventMessage,
  type GameSnapshot,
  type ReconnectResult,
  type RoomSnapshot,
} from "../../../../packages/protocol/src/index";
import { defaultTestConfig, type PlayerSession } from "../../../../tests/clients/server-harness";
import { WsTestClient } from "../../../../tests/clients/ws-client";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { gameSnapshots, rooms, tournaments } from "../../src/infrastructure/persistence/schema";
import { setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";

const SERVER_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));
const TOKEN_SECRET = "tex51-restart-integration-test-hmac-key-000001";
const CONFIG = defaultTestConfig({ maxPlayers: 4, actionTime: 60, timeBank: 0 });

interface ServerProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly httpUrl: string;
  readonly wsUrl: string;
  crash(): Promise<void>;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startProcess(database: IntegrationDatabase, port: number): Promise<ServerProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: SERVER_DIRECTORY,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: database.url,
      DATABASE_SCHEMA: database.schemaName,
      TOKEN_HMAC_SECRET: TOKEN_SECRET,
      TOKEN_HMAC_KEY_ID: "tex51-test",
      TEX_TEST_RNG_SEED: "5101",
      GAME_SERVER_RATE_LIMIT_PROFILE: "default",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  const retainOutput = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-16_384);
  };
  child.stdout!.on("data", retainOutput);
  child.stderr!.on("data", retainOutput);
  try {
    await new Promise<void>((resolve, reject) => {
      const diagnostics = (): string =>
        output.replaceAll(database.url, "[test database]").replaceAll(TOKEN_SECRET, "[test key]");
      const timeout = setTimeout(
        () => finish(new Error(`server startup timed out: ${diagnostics()}`)),
        15_000,
      );
      const ready = (): void => {
        if (output.includes("game-server listening at")) finish();
      };
      const failed = (): void =>
        finish(new Error(`server exited before listening: ${diagnostics()}`));
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        child.stdout!.off("data", ready);
        child.off("exit", failed);
        child.off("error", finish);
        if (error) reject(error);
        else resolve();
      };
      child.stdout!.on("data", ready);
      child.once("exit", failed);
      child.once("error", finish);
    });
  } catch (error) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    throw error;
  }
  return {
    child,
    exited,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/v1/ws`,
    async crash() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

describeTestDatabase("TEX-51 production process restart with original player tokens", (context) => {
  let database: IntegrationDatabase | undefined;
  let server: ServerProcess | undefined;
  let port: number;
  const sockets: WsTestClient[] = [];

  beforeEach(async () => {
    database = await setupIntegrationDatabase(context);
    port = await reservePort();
    server = await startProcess(database, port);
  }, 30_000);

  afterEach(async () => {
    const finishedSockets = sockets.splice(0);
    try {
      await server?.crash();
      for (const socket of finishedSockets) {
        socket.close();
        await socket.closed;
      }
    } finally {
      await database?.end();
      server = undefined;
      database = undefined;
    }
    for (const socket of finishedSockets) expect(socket.schemaViolations).toEqual([]);
  }, 15_000);

  async function request(
    path: string,
    body: unknown,
    token?: string,
    method = "POST",
  ): Promise<Response> {
    return fetch(`${server!.httpUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function createRoom(name: string): Promise<PlayerSession> {
    const response = await request("/api/v1/rooms", { displayName: name, config: CONFIG });
    expect(response.status).toBe(200);
    return CreateRoomResponseSchema.parse(await response.json()).data;
  }

  async function joinRoom(inviteCode: string, name: string): Promise<PlayerSession> {
    const response = await request("/api/v1/rooms/join", { inviteCode, displayName: name });
    expect(response.status).toBe(200);
    return JoinRoomResponseSchema.parse(await response.json()).data;
  }

  async function seat(
    session: PlayerSession,
    seatIndex: number,
    revision: string,
  ): Promise<RoomSnapshot> {
    const response = await request(
      `/api/v1/rooms/${session.roomId}`,
      {
        expectedRoomRevision: revision,
        operation: { type: "CHANGE_SEAT", seat: seatIndex },
      },
      session.playerToken,
      "PATCH",
    );
    expect(response.status).toBe(200);
    return UpdateRoomResponseSchema.parse(await response.json()).data.roomSnapshot;
  }

  async function open(): Promise<WsTestClient> {
    const client = await WsTestClient.open(server!.wsUrl);
    sockets.push(client);
    return client;
  }

  async function connect(
    session: PlayerSession,
  ): Promise<{ client: WsTestClient; auth: ReconnectResult }> {
    const client = await open();
    const result = await client.authenticate(session.roomId, session.playerToken);
    if (!client.isReconnectResult(result)) {
      const code = client.isError(result) ? result.payload.code : result.type;
      throw new Error(`expected successful reconnect, received ${code}`);
    }
    return { client, auth: result.payload };
  }

  async function ready(client: WsTestClient): Promise<void> {
    const requestId = randomUUID();
    const result = client.waitForCommandResult(requestId);
    client.send({ type: "SET_READY", requestId, payload: { ready: true } });
    expect((await result).status).toBe("APPLIED");
  }

  async function snapshot(client: WsTestClient, tournamentId: string): Promise<GameSnapshot> {
    const startIndex = client.messages.length;
    const result = client.waitFor(
      (message) => client.messages.indexOf(message) >= startIndex && client.isGameSnapshot(message),
    );
    client.send({
      type: "REQUEST_SNAPSHOT",
      requestId: randomUUID(),
      payload: { tournamentId, lastSequence: "0", reason: "MANUAL" },
    });
    const message = await result;
    if (!client.isGameSnapshot(message)) throw new Error("expected game snapshot");
    return message.payload;
  }

  async function foldActor(clients: readonly WsTestClient[], tournamentId: string): Promise<void> {
    const views = await Promise.all(clients.map((client) => snapshot(client, tournamentId)));
    const actorIndex = views.findIndex((view) => view.viewer.legalActions?.canFold === true);
    expect(actorIndex).toBeGreaterThanOrEqual(0);
    const actor = clients[actorIndex]!;
    const requestId = randomUUID();
    const result = actor.waitForCommandResult(requestId);
    actor.send({
      type: "SUBMIT_ACTION",
      requestId,
      payload: {
        tournamentId,
        actionId: randomUUID(),
        expectedSequence: views[actorIndex]!.sequence,
        action: { type: "FOLD" },
      },
    });
    expect((await result).status).toBe("APPLIED");
  }

  async function watermark(tournamentId: string): Promise<bigint> {
    const [record] = await database!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    return record!.lastCommittedSequence;
  }

  async function restart(): Promise<void> {
    const oldPid = server!.child.pid;
    await server!.crash();
    server = await startProcess(database!, port);
    expect(server.child.pid).not.toBe(oldPid);
  }

  it("preserves lobby credentials/invite/host while resetting volatile seats, readiness and presence", async () => {
    const host = await createRoom("LobbyHost");
    const guest = await joinRoom(host.roomSnapshot.inviteCode!, "LobbyGuest");
    const hostSeat = await seat(host, 0, guest.roomSnapshot.roomRevision);
    await seat(guest, 1, hostSeat.roomRevision);
    const beforeHost = await connect(host);
    const beforeGuest = await connect(guest);
    await ready(beforeHost.client);
    await ready(beforeGuest.client);
    const readyState = await beforeHost.client.waitFor(
      (message) =>
        beforeHost.client.isRoomSnapshot(message) &&
        message.payload.players.every((player) => player.ready),
    );
    if (!beforeHost.client.isRoomSnapshot(readyState)) throw new Error("expected ready room");
    const previousRoomRevision = readyState.payload.roomRevision;
    await restart();
    await Promise.all([beforeHost.client.closed, beforeGuest.client.closed]);

    const { client: hostClient, auth } = await connect(host);
    expect(auth.tookOver).toBe(false);
    expect(auth.gameSnapshot).toBeNull();
    expect(auth.roomSnapshot).toMatchObject({
      roomId: host.roomId,
      status: "LOBBY",
      inviteCode: host.roomSnapshot.inviteCode,
      hostPlayerId: host.playerId,
      config: CONFIG,
      activeTournamentId: null,
    });
    expect(auth.roomSnapshot.players).toHaveLength(2);
    expect(BigInt(auth.roomSnapshot.roomRevision)).toBeGreaterThan(BigInt(previousRoomRevision));
    for (const player of auth.roomSnapshot.players) {
      expect(player.seat).toBeNull();
      expect(player.ready).toBe(false);
      expect(player.connectionStatus).toBe(
        player.playerId === host.playerId ? "CONNECTED" : "DISCONNECTED",
      );
    }
    const resumedGuest = await connect(guest);
    expect(resumedGuest.auth.roomSnapshot.players.map((player) => player.playerId).sort()).toEqual(
      [host.playerId, guest.playerId].sort(),
    );
    const stale = await request(
      `/api/v1/rooms/${host.roomId}`,
      {
        expectedRoomRevision: previousRoomRevision,
        operation: { type: "CHANGE_SEAT", seat: 2 },
      },
      host.playerToken,
      "PATCH",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_ROOM_STATE" } });
    // HTTP credentials and invite routing survive the same real restart.
    const afterSeat = await seat(host, 2, resumedGuest.auth.roomSnapshot.roomRevision);
    expect(afterSeat.players.find((player) => player.playerId === host.playerId)?.seat).toBe(2);
    const lateGuest = await joinRoom(host.roomSnapshot.inviteCode!, "LateGuest");
    expect(lateGuest.roomId).toBe(host.roomId);

    const wrongTokenClient = await open();
    const wrong = await wrongTokenClient.authenticate(
      host.roomId,
      "invalid-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(wrongTokenClient.isError(wrong)).toBe(true);
    if (wrongTokenClient.isError(wrong)) expect(wrong.payload.code).toBe("AUTH_FAILED");
    expect((await wrongTokenClient.closed).code).toBe(4003);
    expect(hostClient.schemaViolations).toEqual([]);
  }, 30_000);

  it("restores a committed hand, authenticates both original players and commits the next hand with private continuous projections", async () => {
    const host = await createRoom("PlayingHost");
    const guest = await joinRoom(host.roomSnapshot.inviteCode!, "PlayingGuest");
    const hostSeat = await seat(host, 0, guest.roomSnapshot.roomRevision);
    await seat(guest, 1, hostSeat.roomRevision);
    const beforeHost = await connect(host);
    const beforeGuest = await connect(guest);
    await ready(beforeHost.client);
    await ready(beforeGuest.client);
    const readyMessage = await beforeHost.client.waitFor(
      (message) =>
        beforeHost.client.isRoomSnapshot(message) &&
        message.payload.players.every((player) => player.ready),
    );
    if (!beforeHost.client.isRoomSnapshot(readyMessage)) throw new Error("expected ready room");
    const started = await request(
      `/api/v1/rooms/${host.roomId}/tournaments`,
      {
        expectedRoomRevision: readyMessage.payload.roomRevision,
      },
      host.playerToken,
    );
    expect(started.status).toBe(200);
    const { tournamentId } = StartTournamentResponseSchema.parse(await started.json()).data;
    await foldActor([beforeHost.client, beforeGuest.client], tournamentId);
    await expect
      .poll(() => watermark(tournamentId), { timeout: 5_000, interval: 25 })
      .toBeGreaterThan(0n);
    const committedSequence = await watermark(tournamentId);
    const [committed] = await database!.database.db
      .select()
      .from(gameSnapshots)
      .where(eq(gameSnapshots.tournamentId, tournamentId));
    const committedState = committed!.state as {
      handNumber: number;
      participants: { seatIndex: number; chips: number }[];
    };
    expect(committedState.handNumber).toBe(1);
    await restart();
    await Promise.all([beforeHost.client.closed, beforeGuest.client.closed]);

    const recovered = [await connect(host), await connect(guest)];
    for (const [index, { auth }] of recovered.entries()) {
      const session = [host, guest][index]!;
      expect(auth.tookOver).toBe(false);
      expect(BigInt(auth.roomSnapshot.roomRevision)).toBeGreaterThan(
        BigInt(readyMessage.payload.roomRevision),
      );
      expect(auth.roomSnapshot).toMatchObject({
        roomId: host.roomId,
        status: "IN_GAME",
        hostPlayerId: host.playerId,
        activeTournamentId: tournamentId,
      });
      expect(
        auth.roomSnapshot.players.map((player) => ({ id: player.playerId, seat: player.seat })),
      ).toEqual([
        { id: host.playerId, seat: 0 },
        { id: guest.playerId, seat: 1 },
      ]);
      const view = auth.gameSnapshot!;
      expect(view).not.toBeNull();
      expect(view.tournamentId).toBe(tournamentId);
      expect(BigInt(view.sequence)).toBeGreaterThan(committedSequence);
      expect(view.viewer.playerId).toBe(session.playerId);
      expect(view.viewer.holeCards).toHaveLength(2);
      expect(view.players.every((player) => player.revealedCards.length === 0)).toBe(true);
      for (const player of view.players) {
        expect(player.stack + player.totalCommitted).toBe(
          committedState.participants.find((p) => p.seatIndex === player.seat)!.chips,
        );
        expect(player).not.toHaveProperty("holeCards");
      }
      expect(view).not.toHaveProperty("deck");
      expect(view).not.toHaveProperty("burnCards");
      expect(auth.roomSnapshot).not.toHaveProperty("tokenDigest");
    }
    expect(recovered[0]!.auth.gameSnapshot!.viewer.holeCards).not.toEqual(
      recovered[1]!.auth.gameSnapshot!.viewer.holeCards,
    );
    await foldActor(
      recovered.map(({ client }) => client),
      tournamentId,
    );
    await expect
      .poll(() => watermark(tournamentId), { timeout: 5_000, interval: 25 })
      .toBeGreaterThan(committedSequence);
    for (const { client, auth } of recovered) {
      let sequence = BigInt(auth.gameSnapshot!.sequence);
      for (const message of client.messages) {
        if (message.type !== "GAME_EVENT") continue;
        const { payload } = message as GameEventMessage;
        expect(BigInt(payload.sequence)).toBe(sequence + 1n);
        sequence = BigInt(payload.sequence);
        if (
          payload.event.type === "DEAL_HOLE_CARD" &&
          payload.event.payload.playerId !== auth.gameSnapshot!.viewer.playerId
        ) {
          expect(payload.event.payload.card).toBeUndefined();
        }
      }
      expect(sequence).toBeGreaterThan(BigInt(auth.gameSnapshot!.sequence));
      expect(client.schemaViolations).toEqual([]);
    }
  }, 30_000);

  it("isolates a room without a valid persisted host while an unrelated room still reconnects", async () => {
    const invalid = await createRoom("MissingHost");
    const healthy = await createRoom("HealthyHost");
    await server!.crash();
    // Explicit corrupted persistence fixture: recovery must not invent a new host.
    await database!.database.db
      .update(rooms)
      .set({ hostPlayerId: null })
      .where(eq(rooms.id, invalid.roomId));
    server = await startProcess(database!, port);
    const rejected = await open();
    const result = await rejected.authenticate(invalid.roomId, invalid.playerToken);
    expect(rejected.isError(result)).toBe(true);
    expect((await rejected.closed).code).toBe(4003);
    const valid = await connect(healthy);
    expect(valid.auth.roomSnapshot.hostPlayerId).toBe(healthy.playerId);
    const crossRoom = await open();
    const cross = await crossRoom.authenticate(healthy.roomId, invalid.playerToken);
    expect(crossRoom.isError(cross)).toBe(true);
    if (crossRoom.isError(cross)) expect(cross.payload.code).toBe("AUTH_FAILED");
    expect((await crossRoom.closed).code).toBe(4003);
  }, 30_000);
});
