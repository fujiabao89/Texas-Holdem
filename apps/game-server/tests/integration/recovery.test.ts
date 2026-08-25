import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { generateInviteCode, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { computePlayerTokenDigest, sha256Checksum } from "../../src/infrastructure/persistence";
import {
  createHandCommitRepository,
  createRecoveryRepository,
  createRoomRepository,
  createTournamentRepository,
  type HandCommitBundle,
} from "../../src/infrastructure/persistence/repositories";
import {
  gameSnapshots,
  handEvents,
  hands,
  tournamentPlayers,
  tournaments,
} from "../../src/infrastructure/persistence/schema";

/**
 * 崩溃恢复读取/回退仓储（docs/03-data-model.md §4.3/§7.5）：事件连续性验证、
 * 活跃比赛定位、快照读取与「向前退回」回退事务（真实 PostgreSQL）。
 */

describeTestDatabase("recovery repository: 读取与向前退回", (context) => {
  let testDb: IntegrationDatabase | undefined;

  async function createTournamentFixture(displayName: string) {
    const roomId = randomUUID();
    const hostPlayerId = randomUUID();
    await createRoomRepository(testDb!.database).createRoomWithHost({
      roomId,
      mode: "MULTIPLAYER",
      inviteCode: generateInviteCode(),
      configJson: { maxPlayers: 2, startingStack: 1000 },
      host: {
        playerId: hostPlayerId,
        displayName,
        tokenDigest: computePlayerTokenDigest({
          roomId,
          playerId: hostPlayerId,
          token: "token",
          keyId: "k1",
          secret: "secret",
        }),
        tokenKeyId: "k1",
      },
    });
    const tournamentId = randomUUID();
    const participantId = randomUUID();
    await createTournamentRepository(testDb!.database).createTournamentWithPlayers({
      tournamentId,
      roomId,
      tournamentNo: 1,
      configJson: { maxPlayers: 2, startingStack: 1000 },
      players: [
        {
          id: participantId,
          playerId: hostPlayerId,
          displayName,
          seatIndex: 0,
          kind: "HUMAN",
          startingStack: 1000n,
        },
      ],
    });
    return { roomId, hostPlayerId, tournamentId, participantId };
  }

  function buildBundle(input: {
    tournamentId: string;
    handId: string;
    handNumber: number;
    firstSequence: bigint;
    eventCount: number;
    playerUpdates?: HandCommitBundle["playerUpdates"];
  }): HandCommitBundle {
    const events = Array.from({ length: input.eventCount }, (_, i) => ({
      sequence: input.firstSequence + BigInt(i),
      handSequence: i + 1,
      type: i === 0 ? "HAND_STARTED" : "PLAYER_ACTION",
      payload: { index: i },
      schemaVersion: 1,
    }));
    const snapshotSequence = input.firstSequence + BigInt(input.eventCount - 1);
    return {
      tournamentId: input.tournamentId,
      hand: {
        id: input.handId,
        handNumber: input.handNumber,
        dealerSeat: 0,
        sbSeat: 1,
        bbSeat: 2,
        blindLevelIndex: 0,
        smallBlind: 10n,
        bigBlind: 20n,
        communityCards: [],
        summary: { pots: [] },
        endReason: "ALL_FOLDED",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        endedAt: new Date("2026-01-01T00:01:00Z"),
      },
      events,
      snapshot: {
        id: randomUUID(),
        sequence: snapshotSequence,
        state: { handNumber: input.handNumber, handInProgress: false, participants: [{ seatIndex: 0, status: "ACTIVE", chips: 900 }] },
        schemaVersion: 1,
        engineVersion: "poker-engine@0.0.0-test",
        stateChecksum: sha256Checksum({ handNumber: input.handNumber }),
        commitChecksum: sha256Checksum({ handId: input.handId, snapshotSequence }),
      },
      playerUpdates: input.playerUpdates ?? [],
    };
  }

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  it("hasCommittedEventsThrough：事件连续 1..N 无缺口", async () => {
    const fixture = await createTournamentFixture("RecA");
    const commit = createHandCommitRepository(testDb!.database);
    const repo = createRecoveryRepository(testDb!.database);
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
      }),
    );
    expect(await repo.hasCommittedEventsThrough(fixture.tournamentId, 3n)).toBe(true);
    expect(await repo.hasCommittedEventsThrough(fixture.tournamentId, 2n)).toBe(false); // 缺口
    expect(await repo.hasCommittedEventsThrough(fixture.tournamentId, 4n)).toBe(false); // 超界
  });

  it("listActiveTournaments / listSnapshots：定位活跃比赛并按 sequence 降序读取快照", async () => {
    const fixture = await createTournamentFixture("RecB");
    const commit = createHandCommitRepository(testDb!.database);
    const repo = createRecoveryRepository(testDb!.database);
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
      }),
    );
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 2,
        firstSequence: 4n,
        eventCount: 2,
      }),
    );

    const active = await repo.listActiveTournaments();
    const record = active.find((t) => t.tournamentId === fixture.tournamentId)!;
    expect(record.lastCommittedSequence).toBe(5n);
    expect(record.players).toHaveLength(1);

    const snapshots = await repo.listSnapshots(fixture.tournamentId);
    expect(snapshots.map((s) => s.sequence)).toEqual([5n, 3n]); // 降序
  });

  it("rollbackToSnapshot：删除回退区域、复位水位并按快照参与者重置 tournament_players", async () => {
    const fixture = await createTournamentFixture("RecC");
    const commit = createHandCommitRepository(testDb!.database);
    const repo = createRecoveryRepository(testDb!.database);
    const hand1Id = randomUUID();
    const hand2Id = randomUUID();
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: hand1Id,
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
      }),
    );
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: hand2Id,
        handNumber: 2,
        firstSequence: 4n,
        eventCount: 2,
      }),
    );

    // 回退到手 1 末（sequence 3），快照参与者为 ACTIVE/900 筹码。
    await repo.rollbackToSnapshot(fixture.tournamentId, 3n, [
      { seatIndex: 0, status: "ACTIVE", chips: 900, rank: null },
    ]);

    // 事件/快照 > 3 已删除，手 2 已删除，水位复位为 3。
    const events = await testDb!.database.db
      .select()
      .from(handEvents)
      .where(eq(handEvents.tournamentId, fixture.tournamentId));
    expect(events.map((e) => e.sequence)).toEqual([1n, 2n, 3n]);
    const remainingHands = await testDb!.database.db
      .select({ id: hands.id })
      .from(hands)
      .where(eq(hands.tournamentId, fixture.tournamentId));
    expect(remainingHands.map((h) => h.id)).toEqual([hand1Id]);
    const snapshots = await testDb!.database.db
      .select({ sequence: gameSnapshots.sequence })
      .from(gameSnapshots)
      .where(eq(gameSnapshots.tournamentId, fixture.tournamentId));
    expect(snapshots.map((s) => s.sequence)).toEqual([3n]);
    const [tournament] = await testDb!.database.db
      .select({ watermark: tournaments.lastCommittedSequence })
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament!.watermark).toBe(3n);

    // tournament_players 按快照参与者重置。
    const [player] = await testDb!.database.db
      .select({
        pokerStatus: tournamentPlayers.pokerStatus,
        finalStack: tournamentPlayers.finalStack,
        rank: tournamentPlayers.rank,
      })
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, fixture.participantId));
    expect(player!.pokerStatus).toBe("ACTIVE");
    expect(player!.finalStack).toBe(900n);
    expect(player!.rank).toBeNull();
  });

  it("回退区域含淘汰：先清 tournament_players 引用再删手，不违反 eliminated_hand FK（P1-1）", async () => {
    const fixture = await createTournamentFixture("RecD");
    const commit = createHandCommitRepository(testDb!.database);
    const repo = createRecoveryRepository(testDb!.database);
    const hand1Id = randomUUID();
    const hand2Id = randomUUID();
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: hand1Id,
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
      }),
    );
    // 手 2 造成淘汰：participant 的 eliminated_hand_id 指向手 2（回退区域内的待删手）。
    await commit.commitHandBundle(
      buildBundle({
        tournamentId: fixture.tournamentId,
        handId: hand2Id,
        handNumber: 2,
        firstSequence: 4n,
        eventCount: 2,
        playerUpdates: [
          {
            tournamentPlayerId: fixture.participantId,
            pokerStatus: "ELIMINATED",
            finalStack: 0n,
            forfeitedChips: 0n,
            rank: 2,
            eliminatedHandId: hand2Id,
          },
        ],
      }),
    );

    // 回退到手 1 末：参与者恢复到 ACTIVE/满筹码。
    await expect(
      repo.rollbackToSnapshot(fixture.tournamentId, 3n, [
        { seatIndex: 0, status: "ACTIVE", chips: 1000, rank: null },
      ]),
    ).resolves.toBeUndefined(); // 不得因 FK 违例整体回滚

    const remainingHands = await testDb!.database.db
      .select({ id: hands.id })
      .from(hands)
      .where(eq(hands.tournamentId, fixture.tournamentId));
    expect(remainingHands.map((h) => h.id)).toEqual([hand1Id]); // 手 2 已删除
    const [player] = await testDb!.database.db
      .select({
        pokerStatus: tournamentPlayers.pokerStatus,
        eliminatedHandId: tournamentPlayers.eliminatedHandId,
        rank: tournamentPlayers.rank,
      })
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, fixture.participantId));
    expect(player!.pokerStatus).toBe("ACTIVE");
    expect(player!.eliminatedHandId).toBeNull(); // 引用已清空
    expect(player!.rank).toBeNull();
  });
});
