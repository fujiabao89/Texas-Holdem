import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import { ErrorEnvelopeSchema, TournamentResultResponseSchema, type SubmitAction, type TournamentConfig } from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { buildApp } from "../../src/app";
import { parseAppConfig, resolveTokenSecret } from "../../src/config";
import { createNodeIdSource } from "../../src/rooms/id-source";
import { createRoomManager } from "../../src/rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "../../src/rooms/test-support";
import { createTournamentRuntimeState, type PlayerSeed } from "../../src/tournaments/tournament-runtime";
import { projectPlayerView } from "../../src/projection/state-projector";
import { TournamentExecutor } from "../../src/tournaments/tournament-executor";
import { generateInviteCode, qualifiedTableName, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { normalizeDisplayNameKey } from "../../src/infrastructure/persistence/display-name";
import { computePlayerTokenDigest, sha256Checksum } from "../../src/infrastructure/persistence";
import { createHandCommitRepository, createTournamentResultRepository, createRoomRepository, createTournamentRepository, type HandCommitBundle } from "../../src/infrastructure/persistence/repositories";

const SECRET = "tournament-result-test-secret-0123456789abcdef";
const KEY = "v1";
const NOW = 1_760_000_000_000;
const config: TournamentConfig = { maxPlayers: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20, blindMode: "fixed", blindStructure: [{ smallBlind: 10, bigBlind: 20 }], actionTime: 30, timeBank: 60 };
interface Player { playerId: string; token: string }
interface Room { roomId: string; players: Player[] }

describeTestDatabase("TEX-54 durable public tournament result", (context) => {
  let db: IntegrationDatabase;
  let app: FastifyInstance;
  let now = NOW;
  const clocks: ReturnType<typeof createFakeClock>[] = [];
  function makeApp(max = 10000, token = { secret: SECRET, keyId: KEY, retained: {} as Record<string, string> }) {
    const appConfig = parseAppConfig({ TOKEN_HMAC_SECRET: token.secret, TOKEN_HMAC_KEY_ID: token.keyId, TOKEN_HMAC_RETAINED_KEYS: JSON.stringify(token.retained) });
    // Empty RoomManager and no TournamentManager: all authorization/results are durable.
    const manager = createRoomManager({ persistence: fakePersistence(), roomRepository: fakeRoomRepository(), ids: createNodeIdSource(), tokenSecret: appConfig.token.secret, tokenKeyId: appConfig.token.keyId, tokenSecretForKeyId: (keyId) => resolveTokenSecret(appConfig, keyId) });
    return buildApp({ config: appConfig, roomManager: manager, tournamentResultRepository: createTournamentResultRepository(db.database), now: () => now, rateLimit: { max, timeWindow: "1 minute" } });
  }
  beforeAll(async () => { db = await setupIntegrationDatabase(context); app = makeApp(); await app.ready(); });
  afterAll(async () => { clocks.forEach((clock) => clock.dispose()); await app?.close(); await db?.end(); });
  async function get(id: string, token?: string, query = "") {
    const response = await app.inject({ method: "GET", url: `/api/v1/tournaments/${id}/result${query}`, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
    expect(response.headers["cache-control"]).toBe("no-store");
    if (response.statusCode !== 200) ErrorEnvelopeSchema.parse(response.json());
    return response;
  }
  async function room(count: number): Promise<Room> {
    const roomId = randomUUID();
    const players: Player[] = [];
    const repo = createRoomRepository(db.database);
    for (let i = 0; i < count; i++) {
      const playerId = randomUUID();
      const token = `${randomUUID()}-${"x".repeat(40)}`;
      players.push({ playerId, token });
      const displayName = `Player${i}`;
      const tokenDigest = computePlayerTokenDigest({ roomId, playerId, token, keyId: KEY, secret: SECRET });
      if (i === 0) await repo.createRoomWithHost({ roomId, mode: "MULTIPLAYER", inviteCode: generateInviteCode(), configJson: config, host: { playerId, displayName, tokenDigest, tokenKeyId: KEY } });
      else await repo.insertRoomPlayer({ roomId, playerId, displayName, displayNameKey: normalizeDisplayNameKey(displayName), kind: "HUMAN", tokenDigest, tokenKeyId: KEY });
    }
    return { roomId, players };
  }
  async function runtime(count: number, existing?: Room, tournamentNo = 1) {
    const fixture = existing ?? await room(count);
    const tournamentId = randomUUID();
    const seeds: PlayerSeed[] = fixture.players.slice(0, count).map((p, seatIndex) => ({ playerId: p.playerId, tournamentPlayerId: randomUUID(), seatIndex, displayName: `Player${seatIndex}`, kind: "HUMAN", startingStack: 1000 }));
    await createTournamentRepository(db.database).createTournamentWithPlayers({ tournamentId, roomId: fixture.roomId, tournamentNo, configJson: config, players: seeds.map((p) => ({ ...p, id: p.tournamentPlayerId, startingStack: BigInt(p.startingStack) })) });
    await createRoomRepository(db.database).setRoomStatus(fixture.roomId, "IN_GAME");
    const clock = createFakeClock({ now: NOW }); clocks.push(clock);
    const state = createTournamentRuntimeState({ roomId: fixture.roomId, tournamentId, players: seeds, config, rng: new SeededRandomSource(42), engineOptions: { firstDealerSeat: 0 } }, { clock: () => clock.now(), scheduler: clock, ids: { uuid: randomUUID, now: () => clock.now(), randomBytes: (n) => new Uint8Array(n) } });
    const bundles: HandCommitBundle[] = [];
    const executor = new TournamentExecutor(state, { output: { emitEvents() {}, emitClockUpdated() {}, submitRoomCommand() {}, enqueueCommitBundles(batch) { bundles.push(...batch); } } });
    async function action(action: SubmitAction) {
      const seat = state.engine.getState().hand!.currentActor!;
      const result = await executor.submit({ type: "SUBMIT_ACTION", playerId: state.seatToPlayer.get(seat)!, action, requestId: randomUUID(), actionId: randomUUID(), expectedSequence: String(state.lastWireSequence), receivedAt: NOW, ingressOrdinal: 0 });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "APPLIED" });
    }
    async function persist() { for (const bundle of bundles) await createHandCommitRepository(db.database).commitHandBundle(bundle); }
    const view = () => projectPlayerView({ tournamentId, handId: state.currentHandId, sequence: state.lastWireSequence, engineState: state.engine.getState(), seatToPlayer: state.seatToPlayer, actionDeadline: null, currentLegalActions: null, timeBankRemainingMs: new Map(), viewerPlayerId: fixture.players[0].playerId });
    return { ...fixture, tournamentId, seeds, state, executor, bundles, action, persist, view };
  }
  async function finished(count = 2, existing?: Room, tournamentNo = 1) {
    const fixture = await runtime(count, existing, tournamentNo);
    await fixture.executor.submit({ type: "START" });
    await fixture.action({ type: "ALL_IN" });
    for (let i = 1; i < count; i++) await fixture.action({ type: "CALL" });
    expect(fixture.state.status).toBe("FINISHED");
    expect(fixture.bundles.at(-1)?.tournamentFinish?.status).toBe("FINISHED");
    await fixture.persist();
    return fixture;
  }
  function table(name: string) { return qualifiedTableName(db.schemaName, name); }
  async function damageState(id: string, mutate: (state: Record<string, unknown>) => void, checksum = true) {
    const rows = await db.adminPool.query(`SELECT state FROM ${table("game_snapshots")} WHERE tournament_id = $1 ORDER BY sequence DESC LIMIT 1`, [id]);
    const raw = rows.rows[0].state;
    const state = typeof raw === "string" ? JSON.parse(raw) : raw;
    mutate(state);
    await db.adminPool.query(`UPDATE ${table("game_snapshots")} SET state = $2::jsonb${checksum ? ", state_checksum = $3" : ""} WHERE tournament_id = $1`, checksum ? [id, JSON.stringify(state), sha256Checksum(state)] : [id, JSON.stringify(state)]);
  }

  it("real executor → unchanged production bundle → PostgreSQL → fresh server returns final public projection, including ties", async () => {
    const f = await finished(3);
    const before = await get(f.tournamentId, f.players[0].token);
    expect(before.statusCode, before.body).toBe(200);
    const body = TournamentResultResponseSchema.parse(before.json());
    const live = f.view();
    expect(body.data.rankings).toEqual(live.rankings);
    expect(body.data.players.map((p) => [p.playerId, p.finalStack, p.pokerStatus])).toEqual(live.players.map((p) => [p.playerId, p.stack, p.pokerStatus]));
    expect(body.data.rankings.filter((r) => r.placement.from === 2)).toHaveLength(2);
    expect(body.data.rankings.filter((r) => r.placement.from === 2).map((r) => r.placement)).toEqual([{ from: 2, to: 3 }, { from: 2, to: 3 }]);
    expect(body.data.finishedAt).toBe(NOW);
    expect(body.data.championPlayerId).toBe(f.state.seatToPlayer.get(f.state.engine.getState().champion!));
    const stored = await db.adminPool.query(`SELECT jsonb_typeof(state) AS kind FROM ${table("game_snapshots")} WHERE tournament_id = $1`, [f.tournamentId]);
    expect(stored.rows[0].kind).toBe("string");
    const read = await createTournamentResultRepository(db.database).read(f.tournamentId, NOW, () => true);
    expect(read.kind).toBe("result");
    if (read.kind === "result") expect(typeof read.record.snapshot?.state).toBe("object");
    // Fully close/rebuild the HTTP application while no runtime manager is supplied.
    await app.close(); app = makeApp(); await app.ready();
    expect((await get(f.tournamentId, f.players[1].token)).json()).toEqual(body);
  });

  it("密钥轮换后由持久化 keyId 解析保留密钥，旧 Room token 仍可读取结果", async () => {
    const f = await finished();
    await app.close();
    app = makeApp(10000, { secret: "rotated-current-secret-0123456789abcdef", keyId: "v2", retained: { [KEY]: SECRET } });
    await app.ready();
    const response = await get(f.tournamentId, f.players[0].token);
    expect(response.statusCode, response.body).toBe(200);
  });

  it("same Room non-participant can read public result; old and new tournaments remain isolated", async () => {
    const r = await room(3);
    const old = await finished(2, r);
    const current = await runtime(2, r, 2);
    const archived = await get(old.tournamentId, r.players[2].token);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.tournamentId).toBe(old.tournamentId);
    expect(archived.json().data.players.map((p: { playerId: string }) => p.playerId)).not.toContain(r.players[2].playerId);
    expect((await get(current.tournamentId, r.players[2].token)).json().error.code).toBe("TOURNAMENT_NOT_FINISHED");
  });

  it("active in-hand withdrawal persists zero final chips and no invented ranking", async () => {
    const f = await runtime(2);
    await f.executor.submit({ type: "START" });
    await f.executor.submit({ type: "WITHDRAW_PLAYER", playerId: f.players[0].playerId, reason: "USER_LEFT" });
    expect(f.state.status).toBe("FINISHED"); await f.persist();
    const result = await get(f.tournamentId, f.players[1].token);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.players[0]).toMatchObject({ pokerStatus: "WITHDRAWN", finalStack: 0 });
    expect(result.json().data.rankings).toHaveLength(1);
    expect(result.json().data.championPlayerId).toBe(f.players[1].playerId);
  });

  it("real championless finish stays readable by an active eliminated room member", async () => {
    const f = await runtime(3);
    await f.executor.submit({ type: "START" }); await f.executor.submit({ type: "PAUSE_AFTER_HAND", paused: true });
    await f.action({ type: "ALL_IN" }); await f.action({ type: "CALL" }); await f.action({ type: "FOLD" });
    const eliminated = f.state.engine.getState().participants.find((p) => p.status === "ELIMINATED")!;
    expect(eliminated).toBeDefined();
    await f.executor.submit({ type: "PAUSE_AFTER_HAND", paused: false });
    const seat = f.state.engine.getState().hand!.currentActor!;
    await f.action({ type: "ALL_IN" });
    await f.executor.submit({ type: "WITHDRAW_PLAYER", playerId: f.players[seat].playerId, reason: "USER_LEFT" });
    const other = f.state.engine.getState().participants.find((p) => p.status === "ACTIVE")!;
    await f.executor.submit({ type: "WITHDRAW_PLAYER", playerId: f.players[other.seatIndex].playerId, reason: "USER_LEFT" });
    expect(f.state.status).toBe("FINISHED"); await f.persist();
    const result = await get(f.tournamentId, f.players[eliminated.seatIndex].token);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.championPlayerId).toBeNull();
    expect(result.json().data.rankings).toEqual([{ playerId: f.players[eliminated.seatIndex].playerId, placement: { from: 1, to: 1 }, displayOrder: 1 }]);
    expect(result.json().data.players.filter((p: { pokerStatus: string }) => p.pokerStatus === "WITHDRAWN")).toHaveLength(2);
  });

  it("rejects missing, wrong-Room, invalid, revoked, LEFT and CLOSED credentials", async () => {
    const f = await finished(); const outsider = await room(2);
    expect((await get(f.tournamentId)).json().error.code).toBe("AUTH_REQUIRED");
    for (const token of ["incorrect-token", outsider.players[0].token]) expect((await get(f.tournamentId, token)).json().error.code).toBe("AUTH_FAILED");
    await createRoomRepository(db.database).markRoomPlayerLeft(f.roomId, f.players[0].playerId, "USER_LEFT", new Date(NOW));
    expect((await get(f.tournamentId, f.players[0].token)).json().error.code).toBe("AUTH_FAILED");
    await createRoomRepository(db.database).setRoomStatus(f.roomId, "CLOSED", { closedReason: "ABANDONED_NO_HUMAN", closedAt: new Date(NOW), retentionExpiresAt: new Date(NOW + 86_400_000) });
    expect((await get(f.tournamentId, f.players[1].token)).json().error.code).toBe("AUTH_FAILED");
    const revoked = await finished();
    const replacement = computePlayerTokenDigest({ roomId: revoked.roomId, playerId: revoked.players[0].playerId, token: "replaced", keyId: KEY, secret: SECRET });
    await db.adminPool.query(`UPDATE ${table("room_players")} SET token_digest = $2 WHERE id = $1`, [revoked.players[0].playerId, replacement]);
    expect((await get(revoked.tournamentId, revoked.players[0].token)).json().error.code).toBe("AUTH_FAILED");
  });

  it("UUID/query validation, missing/unfinished/abandoned/expired results use stable safe errors", async () => {
    const f = await runtime(2);
    for (const [id, query] of [["invalid", ""], [f.tournamentId, "?playerToken=must-not-be-accepted"], [f.tournamentId, "?playerId=x"]]) expect((await get(id, f.players[0].token, query)).json().error.code).toBe("INVALID_MESSAGE");
    expect((await get(randomUUID(), f.players[0].token)).json().error.code).toBe("TOURNAMENT_NOT_FOUND");
    expect((await get(f.tournamentId, f.players[0].token)).statusCode).toBe(409);
    await db.adminPool.query(`UPDATE ${table("tournaments")} SET status = 'ABANDONED_NO_HUMAN', finished_at = $2, retention_expires_at = $3 WHERE id = $1`, [f.tournamentId, new Date(NOW), new Date(NOW + 10000)]);
    expect((await get(f.tournamentId, f.players[0].token)).json().error.code).toBe("TOURNAMENT_NOT_FINISHED");
    const done = await finished();
    const retention = await db.adminPool.query(`SELECT retention_expires_at FROM ${table("tournaments")} WHERE id = $1`, [done.tournamentId]);
    now = retention.rows[0].retention_expires_at.getTime();
    try { expect((await get(done.tournamentId, done.players[0].token)).json().error.code).toBe("TOURNAMENT_NOT_FOUND"); }
    finally { now = NOW; }
    const after = await db.adminPool.query(`SELECT retention_expires_at FROM ${table("tournaments")} WHERE id = $1`, [done.tournamentId]);
    expect(after.rows).toEqual(retention.rows);
  });

  it.each(["missing-snapshot", "missing-event", "checksum", "bad-json", "version", "sequence", "missing-player", "missing-standing", "wrong-champion", "rank", "chips"])("incomplete durable %s fails closed", async (damage) => {
    const f = await finished();
    if (damage === "missing-snapshot") await db.adminPool.query(`DELETE FROM ${table("game_snapshots")} WHERE tournament_id = $1`, [f.tournamentId]);
    if (damage === "missing-event") await db.adminPool.query(`DELETE FROM ${table("hand_events")} WHERE tournament_id = $1 AND type = 'TOURNAMENT_FINISHED'`, [f.tournamentId]);
    if (damage === "checksum") await damageState(f.tournamentId, (s) => { s.nextSequence = 9; }, false);
    if (damage === "bad-json") await db.adminPool.query(`UPDATE ${table("game_snapshots")} SET state = '"invalid-json"'::jsonb WHERE tournament_id = $1`, [f.tournamentId]);
    if (damage === "version") await db.adminPool.query(`UPDATE ${table("game_snapshots")} SET schema_version = 999 WHERE tournament_id = $1`, [f.tournamentId]);
    if (damage === "sequence") await damageState(f.tournamentId, (s) => { s.nextSequence = 1; });
    if (damage === "missing-player") await damageState(f.tournamentId, (s) => { (s.participants as unknown[]).pop(); });
    if (damage === "missing-standing") await damageState(f.tournamentId, (s) => { s.finalStandings = []; });
    if (damage === "wrong-champion") await db.adminPool.query(`UPDATE ${table("tournaments")} SET champion_tournament_player_id = NULL WHERE id = $1`, [f.tournamentId]);
    if (damage === "rank") await db.adminPool.query(`UPDATE ${table("tournament_players")} SET rank = 9 WHERE tournament_id = $1 AND rank = 2`, [f.tournamentId]);
    if (damage === "chips") await db.adminPool.query(`UPDATE ${table("tournament_players")} SET final_stack = NULL WHERE tournament_id = $1 AND rank = 1`, [f.tournamentId]);
    const response = await get(f.tournamentId, f.players[0].token);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error).toMatchObject({ code: "TOURNAMENT_RESULT_INCOMPLETE", retryable: true });
  });

  it("allow-list projection omits private snapshot fields and identity data from HTTP metrics", async () => {
    const f = await finished();
    await damageState(f.tournamentId, (s) => { s.privateMarker = "PRIVATE-DECK-TOKEN-MARKER"; });
    const response = await get(f.tournamentId, f.players[0].token);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().data).sort()).toEqual(["championPlayerId", "finishedAt", "players", "rankings", "status", "tournamentId"]);
    for (const secret of ["PRIVATE-DECK-TOKEN-MARKER", "holeCards", "burn", "deck", "serverTimeBank", "tokenDigest", "payload", ...f.seeds.map((p) => p.tournamentPlayerId), ...f.players.map((p) => p.token)]) expect(response.body).not.toContain(secret);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).not.toContain(f.tournamentId); expect(metrics.body).not.toContain(f.players[0].token);

  });

  it("rate-limit early failure also uses no-store and the protocol error envelope", async () => {
    const limited = makeApp(1);
    try {
      const url = `/api/v1/tournaments/${randomUUID()}/result`;
      await limited.inject({ method: "GET", url });
      const response = await limited.inject({ method: "GET", url });
      expect(response.statusCode).toBe(429);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(response.json()).error.code).toBe("RATE_LIMITED");
    } finally { await limited.close(); }
  });
});
