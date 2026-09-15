import { afterAll, beforeAll, expect, it } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import { GameSnapshotSchema, type GameEventMessage, type TournamentConfig } from "@texas-holdem/protocol";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { generateInviteCode, qualifiedTableName, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { computePlayerTokenDigest } from "../../src/infrastructure/persistence";
import { createRoomRepository, createTournamentRepository, createHandCommitRepository, createRecoveryRepository, type HandCommitBundle } from "../../src/infrastructure/persistence/repositories";
import { createTournamentRuntimeState, type PlayerSeed } from "../../src/tournaments/tournament-runtime";
import { TournamentExecutor, type TournamentOutputSink } from "../../src/tournaments/tournament-executor";
import { createTournamentManager } from "../../src/tournaments/tournament-manager";
import { recoverActiveTournaments } from "../../src/persistence/recovery";
import { projectPlayerView } from "../../src/projection/state-projector";

describeTestDatabase("TEX-53 production bundle → PostgreSQL → recovery blind seats", (context) => {
  let testDb: IntegrationDatabase | undefined;
  beforeAll(async () => { testDb = await setupIntegrationDatabase(context); });
  afterAll(async () => { await testDb?.end(); });

  it("reads the actual JSONB string snapshot and starts the next hand with continuous sequences and authoritative seats", async () => {
    const clock = createFakeClock({ now: 1_760_000_000_000 });
    const ids = { uuid: randomUUID, now: clock.now, randomBytes: (count: number) => new Uint8Array(count) };
    const config: TournamentConfig = { maxPlayers: 6, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed", blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30, timeBank: 60 };
    const roomId = randomUUID();
    const tournamentId = randomUUID();
    const players: PlayerSeed[] = [0, 4].map((seatIndex) => ({ playerId: randomUUID(), tournamentPlayerId: randomUUID(), seatIndex, displayName: `Seat ${seatIndex}`, kind: "HUMAN", startingStack: 1000 }));
    const roomRepo = createRoomRepository(testDb!.database);
    for (const [index, player] of players.entries()) {
      const tokenDigest = computePlayerTokenDigest({ roomId, playerId: player.playerId, token: "test-token", keyId: "k1", secret: "test-secret" });
      if (index === 0) await roomRepo.createRoomWithHost({ roomId, mode: "MULTIPLAYER", inviteCode: generateInviteCode(), configJson: config, host: { playerId: player.playerId, displayName: player.displayName, tokenDigest, tokenKeyId: "k1" } });
      else await roomRepo.insertRoomPlayer({ roomId, playerId: player.playerId, displayName: player.displayName, displayNameKey: player.displayName.toLowerCase(), kind: "HUMAN", tokenDigest, tokenKeyId: "k1" });
    }
    await createTournamentRepository(testDb!.database).createTournamentWithPlayers({ tournamentId, roomId, tournamentNo: 1, configJson: config, players: players.map((player) => ({ id: player.tournamentPlayerId, playerId: player.playerId, seatIndex: player.seatIndex, displayName: player.displayName, kind: player.kind, startingStack: BigInt(player.startingStack) })) });
    await roomRepo.setRoomStatus(roomId, "IN_GAME");
    const bundles: HandCommitBundle[] = [];
    const messages: GameEventMessage[] = [];
    const output: TournamentOutputSink = {
      emitEvents(events) { messages.push(...events); }, emitClockUpdated() {}, submitRoomCommand() {},
      enqueueCommitBundles(batch) { bundles.push(...batch); },
    };
    const runtime = createTournamentRuntimeState({ roomId, tournamentId, players, config, rng: new SeededRandomSource(53), engineOptions: { firstDealerSeat: 0 } }, { clock: clock.now, scheduler: clock, ids });
    const executor = new TournamentExecutor(runtime, { output });
    await executor.submit({ type: "START" });
    const result = await executor.submit({ type: "SUBMIT_ACTION", playerId: players[0]!.playerId, action: { type: "FOLD" }, requestId: randomUUID(), actionId: randomUUID(), expectedSequence: String(runtime.lastWireSequence), receivedAt: clock.now(), ingressOrdinal: 0 });
    expect(result).toMatchObject({ status: "APPLIED" });
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(typeof bundle.snapshot.state).toBe("string");
    await createHandCommitRepository(testDb!.database).commitHandBundle(bundle);
    const recoveryRepo = createRecoveryRepository(testDb!.database);
    const stored = await recoveryRepo.listSnapshots(tournamentId);
    const raw = await testDb!.adminPool.query<{ state_type: string }>(`SELECT jsonb_typeof(state) AS state_type FROM ${qualifiedTableName(testDb!.schemaName, "game_snapshots")} WHERE tournament_id = $1`, [tournamentId]);
    expect(raw.rows[0]!.state_type).toBe("string");
    expect(typeof stored[0]!.state).toBe("object");
    expect(stored[0]!.schemaVersion).toBe(2);
    const decoded = stored[0]!.state as { hand: { dealerSeat: number; sbSeat: number; bbSeat: number } };
    expect(decoded.hand).toMatchObject({ dealerSeat: 0, sbSeat: 0, bbSeat: 4 });

    messages.length = 0;
    const manager = createTournamentManager({ clock: clock.now, ids, scheduler: clock, output, executorDeps: {} });
    const summary = await recoverActiveTournaments({ recoveryRepo, manager, clock: clock.now, ids, scheduler: clock, rngFactory: () => new SeededRandomSource(53) });
    expect(summary.unrecovered).toEqual([]);
    expect(summary.recovered).toEqual([{ tournamentId, fromSequence: bundle.snapshot.sequence }]);
    // The serial queue barrier waits for the recovery START command without advancing timers.
    await manager.setConnection(tournamentId, players[0]!.playerId, true);
    const restored = manager.getView(tournamentId)!;
    const view = projectPlayerView({ tournamentId, handId: restored.currentHandId, sequence: restored.lastWireSequence, engineState: restored.engineState, seatToPlayer: restored.seatToPlayer, actionDeadline: restored.actionDeadline, currentLegalActions: restored.currentLegalActions, timeBankRemainingMs: restored.timeBankRemainingMs, viewerPlayerId: players[0]!.playerId });
    expect(restored.engineState.handNumber).toBe(2);
    expect(view).toMatchObject({ dealerSeat: 4, smallBlindSeat: 4, bigBlindSeat: 0 });
    for (const reason of ["INITIAL", "RECONNECT", "RESYNC", "FAST_FORWARD"] as const) {
      expect(GameSnapshotSchema.parse({ snapshotVersion: 1, reason, tournamentId, sequence: String(restored.lastWireSequence), ...view })).toMatchObject({ dealerSeat: 4, smallBlindSeat: 4, bigBlindSeat: 0 });
    }
    const events = messages.filter((message) => message.payload.patch.viewer?.playerId === players[0]!.playerId);
    expect(events[0]!.payload.sequence).toBe(String(bundle.snapshot.sequence + 1n));
    events.forEach((message, index) => {
      expect(message.payload.sequence).toBe(String(bundle.snapshot.sequence + BigInt(index + 1)));
      expect(message.payload.patch).toMatchObject({ dealerSeat: 4, smallBlindSeat: 4, bigBlindSeat: 0 });
    });
  });
});
