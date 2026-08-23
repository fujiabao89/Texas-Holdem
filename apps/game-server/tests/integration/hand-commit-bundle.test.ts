import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { generateInviteCode, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { computePlayerTokenDigest, sha256Checksum } from "../../src/infrastructure/persistence";
import {
  CommitChecksumMismatchError,
  createHandCommitRepository,
  createRoomRepository,
  createTournamentRepository,
  HandSequenceIntegrityError,
  PartialCommitConflictError,
  PersistenceError,
  SequenceIntegrityError,
  TournamentNotFoundError,
  TournamentPlayerUpdateTargetError,
  type HandCommitBundle,
} from "../../src/infrastructure/persistence/repositories";
import {
  gameSnapshots,
  handEvents,
  hands,
  rooms,
  tournaments,
  tournamentPlayers,
} from "../../src/infrastructure/persistence/schema";

/**
 * 手末 Commit Bundle（docs/03-data-model.md §7.3/§7.4，任务测试项 3/4/5）：
 * 单事务原子提交、Event 顺序与 Snapshot/水位线对齐、失败整体回滚、
 * 幂等重试与部分冲突/内容不一致的安全失败。
 */

describeTestDatabase("hand commit bundle: 原子性与幂等", (context) => {
  let testDb: IntegrationDatabase | undefined;
  // 每个用例独立的 room/tournament，避免用例间共享可变状态。
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
    participantId: string;
    commitPayload?: unknown;
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
        communityCards: ["AS", "KD", "7C"],
        summary: { pots: [] },
        endReason: "SHOWDOWN",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        endedAt: new Date("2026-01-01T00:01:00Z"),
      },
      events,
      snapshot: {
        id: randomUUID(),
        sequence: snapshotSequence,
        state: { handNumber: input.handNumber, deck: [] },
        schemaVersion: 1,
        engineVersion: "poker-engine@0.0.0-test",
        stateChecksum: sha256Checksum({ handNumber: input.handNumber }),
        commitChecksum: sha256Checksum(input.commitPayload ?? { handId: input.handId, snapshotSequence }),
      },
      playerUpdates: [],
    };
  }

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  it("成功提交：events 连续落库、snapshot 与水位线对齐（§7.3/§8）", async () => {
    const fixture = await createTournamentFixture("Alpha");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 4,
      participantId: fixture.participantId,
    });

    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    const events = await testDb!.database.db
      .select()
      .from(handEvents)
      .where(eq(handEvents.tournamentId, fixture.tournamentId));
    expect(events.map((e) => e.sequence)).toEqual([1n, 2n, 3n, 4n]);
    expect(events.map((e) => e.handSequence)).toEqual([1, 2, 3, 4]);

    const [snapshot] = await testDb!.database.db
      .select()
      .from(gameSnapshots)
      .where(eq(gameSnapshots.tournamentId, fixture.tournamentId));
    expect(snapshot.sequence).toBe(4n);
    expect(snapshot.handId).toBe(bundle.hand.id);

    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.lastCommittedSequence).toBe(4n);

    // 第二手：sequence 跨手连续（水位线 4 → 5..8）。
    const secondBundle = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 2,
      firstSequence: 5n,
      eventCount: 4,
      participantId: fixture.participantId,
    });
    await expect(repo.commitHandBundle(secondBundle)).resolves.toBe("committed");
    const [tournamentAfterSecond] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournamentAfterSecond.lastCommittedSequence).toBe(8n);
  });

  it("任一写入失败整体回滚：不遗留半手（playerUpdates 触发 CHECK 失败）", async () => {
    const fixture = await createTournamentFixture("Beta");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
        participantId: fixture.participantId,
      }),
      playerUpdates: [
        {
          tournamentPlayerId: fixture.participantId,
          pokerStatus: "ELIMINATED",
          finalStack: -1n, // 违反 final_stack >= 0：失败注入点在 hands/events/snapshot 之后
          forfeitedChips: 0n,
          rank: 1,
          eliminatedHandId: null,
        },
      ],
    };

    await expect(repo.commitHandBundle(bundle)).rejects.toMatchObject({ cause: { code: "23514" } });

    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
    expect(
      await testDb!.database.db
        .select()
        .from(handEvents)
        .where(eq(handEvents.handId, bundle.hand.id)),
    ).toHaveLength(0);
    expect(
      await testDb!.database.db
        .select()
        .from(gameSnapshots)
        .where(eq(gameSnapshots.id, bundle.snapshot.id)),
    ).toHaveLength(0);
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.lastCommittedSequence).toBe(0n);
  });

  it("相同 checksum 的幂等重试成功且不产生重复行（§7.4）", async () => {
    const fixture = await createTournamentFixture("Gamma");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 3,
      participantId: fixture.participantId,
    });
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("already-committed");

    const events = await testDb!.database.db
      .select()
      .from(handEvents)
      .where(eq(handEvents.tournamentId, fixture.tournamentId));
    expect(events).toHaveLength(3);
    const snapshots = await testDb!.database.db
      .select()
      .from(gameSnapshots)
      .where(eq(gameSnapshots.tournamentId, fixture.tournamentId));
    expect(snapshots).toHaveLength(1);
  });

  it("同 ID 不同 commit_checksum 的重试被拒绝（数据损坏信号）", async () => {
    const fixture = await createTournamentFixture("Delta");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 3,
      participantId: fixture.participantId,
    });
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    const tampered: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: bundle.hand.id,
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 3,
        participantId: fixture.participantId,
        commitPayload: { different: "content" },
      }),
      snapshot: {
        ...buildBundle({
          tournamentId: fixture.tournamentId,
          handId: bundle.hand.id,
          handNumber: 1,
          firstSequence: 1n,
          eventCount: 3,
          participantId: fixture.participantId,
          commitPayload: { different: "content" },
        }).snapshot,
        id: bundle.snapshot.id,
      },
    };
    await expect(repo.commitHandBundle(tampered)).rejects.toBeInstanceOf(CommitChecksumMismatchError);
  });

  it("部分冲突（hand 存在但 snapshot 缺失）被拒绝（§7.4）", async () => {
    const fixture = await createTournamentFixture("Epsilon");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 2,
      participantId: fixture.participantId,
    });
    // 手工制造"半手"：直接插入 hand 行但不插 snapshot，模拟原子性被破坏。
    await testDb!.database.db.insert(hands).values({
      id: bundle.hand.id,
      tournamentId: fixture.tournamentId,
      handNumber: 1,
      dealerSeat: 0,
      sbSeat: 1,
      bbSeat: 2,
      blindLevelIndex: 0,
      smallBlind: 10n,
      bigBlind: 20n,
      communityCards: [],
      summary: {},
      endReason: "ABANDONED",
    });
    await expect(repo.commitHandBundle(bundle)).rejects.toBeInstanceOf(PartialCommitConflictError);
  });

  it("playerUpdates 指向其他 Tournament 的参赛者被拒绝且不污染对方赛果（§7.4 跨赛防护）", async () => {
    const fixtureA = await createTournamentFixture("Iota");
    const fixtureB = await createTournamentFixture("Kappa");
    const repo = createHandCommitRepository(testDb!.database);
    // B 先正常提交一手，使其参赛者成为"有结果可篡改"的目标。
    await repo.commitHandBundle(
      buildBundle({
        tournamentId: fixtureB.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixtureB.participantId,
      }),
    );

    const [bBefore] = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, fixtureB.participantId));

    // 向 A 提交 bundle，但 playerUpdates 指向 B 的参赛者（脏 id/恢复重试场景）。
    const malicious: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixtureA.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixtureA.participantId,
      }),
      playerUpdates: [
        {
          tournamentPlayerId: fixtureB.participantId,
          pokerStatus: "ELIMINATED",
          finalStack: 0n,
          forfeitedChips: 0n,
          rank: 1,
          eliminatedHandId: null,
        },
      ],
    };
    await expect(repo.commitHandBundle(malicious)).rejects.toBeInstanceOf(
      TournamentPlayerUpdateTargetError,
    );

    // B 的参赛者未被改动；A 未遗留半手、水位线未推进。
    const [bAfter] = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, fixtureB.participantId));
    expect(bAfter.pokerStatus).toBe(bBefore.pokerStatus);
    expect(bAfter.rank).toBe(bBefore.rank);
    expect(bAfter.finalStack).toBe(bBefore.finalStack);
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, malicious.hand.id)),
    ).toHaveLength(0);
    const [aTournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixtureA.tournamentId));
    expect(aTournament.lastCommittedSequence).toBe(0n);
  });

  it("playerUpdates 指向不存在的参赛者被拒绝（拒绝静默 0 行更新）", async () => {
    const fixture = await createTournamentFixture("Lambda");
    const repo = createHandCommitRepository(testDb!.database);
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixture.participantId,
      }),
      playerUpdates: [
        {
          tournamentPlayerId: randomUUID(), // 不存在
          pokerStatus: "ELIMINATED",
          finalStack: 0n,
          forfeitedChips: 0n,
          rank: 2,
          eliminatedHandId: null,
        },
      ],
    };
    await expect(repo.commitHandBundle(bundle)).rejects.toBeInstanceOf(
      TournamentPlayerUpdateTargetError,
    );
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.lastCommittedSequence).toBe(0n);
  });

  it("序列缺口/末位不对齐/空事件/hand_sequence 缺口全部被拒", async () => {
    const fixture = await createTournamentFixture("Zeta");
    const repo = createHandCommitRepository(testDb!.database);
    // 先提交第一手（水位线 3）。
    const first = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 3,
      participantId: fixture.participantId,
    });
    await repo.commitHandBundle(first);

    // 缺口：第二手从水位线 + 2 开始。
    const gap = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 2,
      firstSequence: 5n,
      eventCount: 2,
      participantId: fixture.participantId,
    });
    await expect(repo.commitHandBundle(gap)).rejects.toBeInstanceOf(SequenceIntegrityError);

    // 末位不对齐：snapshot.sequence != 最后一个 event.sequence。
    const misalignedBase = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 2,
      firstSequence: 4n,
      eventCount: 2,
      participantId: fixture.participantId,
    });
    const misaligned: HandCommitBundle = {
      ...misalignedBase,
      snapshot: { ...misalignedBase.snapshot, sequence: 10n },
    };
    await expect(repo.commitHandBundle(misaligned)).rejects.toBeInstanceOf(SequenceIntegrityError);

    // hand_sequence 缺口（跳过 2）。
    const holeyBase = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 2,
      firstSequence: 4n,
      eventCount: 2,
      participantId: fixture.participantId,
    });
    const holey: HandCommitBundle = {
      ...holeyBase,
      events: holeyBase.events.map((event, i) => ({ ...event, handSequence: i === 0 ? 1 : 3 })),
    };
    await expect(repo.commitHandBundle(holey)).rejects.toBeInstanceOf(HandSequenceIntegrityError);

    // 空事件。
    const emptyBase = buildBundle({
      tournamentId: fixture.tournamentId,
      handId: randomUUID(),
      handNumber: 2,
      firstSequence: 4n,
      eventCount: 2,
      participantId: fixture.participantId,
    });
    const empty: HandCommitBundle = { ...emptyBase, events: [] };
    await expect(repo.commitHandBundle(empty)).rejects.toBeInstanceOf(SequenceIntegrityError);

    // 水位线未被任何失败尝试推进。
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.lastCommittedSequence).toBe(3n);
  });

  it("不存在的 Tournament 被拒绝", async () => {
    const repo = createHandCommitRepository(testDb!.database);
    const bundle = buildBundle({
      tournamentId: randomUUID(),
      handId: randomUUID(),
      handNumber: 1,
      firstSequence: 1n,
      eventCount: 1,
      participantId: randomUUID(),
    });
    await expect(repo.commitHandBundle(bundle)).rejects.toBeInstanceOf(TournamentNotFoundError);
  });

  it("终结手：tournamentFinish 同事务更新 Tournament/Room/champion（§7.3）", async () => {
    const fixture = await createTournamentFixture("Eta");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date("2026-01-01T01:00:00Z");
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixture.participantId,
      }),
      playerUpdates: [
        {
          tournamentPlayerId: fixture.participantId,
          pokerStatus: "ACTIVE",
          finalStack: 2000n,
          forfeitedChips: 0n,
          rank: 1,
          eliminatedHandId: null,
        },
      ],
      tournamentFinish: {
        status: "FINISHED",
        championTournamentPlayerId: fixture.participantId,
        finishedAt,
        retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
        roomStatus: "FINISHED",
      },
    };
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("FINISHED");
    expect(tournament.championTournamentPlayerId).toBe(fixture.participantId);
    expect(tournament.lastCommittedSequence).toBe(2n);

    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("FINISHED");

    const [participant] = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, fixture.participantId));
    expect(participant.pokerStatus).toBe("ACTIVE");
    expect(participant.finalStack).toBe(2000n);
    expect(participant.rank).toBe(1);
  });

  it("ABANDONED_NO_HUMAN 不得宣告冠军（应用层先拒，整体回滚）", async () => {
    const fixture = await createTournamentFixture("Theta");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date();
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 1,
        participantId: fixture.participantId,
      }),
      tournamentFinish: {
        status: "ABANDONED_NO_HUMAN",
        championTournamentPlayerId: fixture.participantId, // 非法
        finishedAt,
        retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
      },
    };
    await expect(repo.commitHandBundle(bundle)).rejects.toThrow(/champion/i);
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
  });

  it("无真人关房：roomStatus=CLOSED 同事务写齐 closed_at/closed_reason/retention（§5.1）", async () => {
    const fixture = await createTournamentFixture("Mu");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date("2026-01-01T02:00:00Z");
    const closedAt = new Date("2026-01-01T02:00:01Z");
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixture.participantId,
      }),
      tournamentFinish: {
        status: "ABANDONED_NO_HUMAN",
        championTournamentPlayerId: null,
        finishedAt,
        retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
        roomStatus: "CLOSED",
        roomClosure: {
          closedAt,
          closedReason: "ABANDONED_NO_HUMAN",
          retentionExpiresAt: new Date(closedAt.getTime() + 180 * 24 * 3600 * 1000),
        },
      },
    };
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    // 终局三件套整体可见：Room CLOSED + 元数据、Tournament 终态、Hand/Snapshot。
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("CLOSED");
    expect(room.closedAt?.toISOString()).toBe(closedAt.toISOString());
    expect(room.closedReason).toBe("ABANDONED_NO_HUMAN");
    expect(room.retentionExpiresAt?.toISOString()).toBe(
      new Date(closedAt.getTime() + 180 * 24 * 3600 * 1000).toISOString(),
    );
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("ABANDONED_NO_HUMAN");
    expect(tournament.championTournamentPlayerId).toBeNull();
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(1);
    expect(
      await testDb!.database.db
        .select()
        .from(gameSnapshots)
        .where(eq(gameSnapshots.id, bundle.snapshot.id)),
    ).toHaveLength(1);
  });

  it("roomStatus=CLOSED 缺 roomClosure 被拒绝（否则 DB CHECK 23514 回滚整个 Bundle）", async () => {
    const fixture = await createTournamentFixture("Nu");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date();
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixture.participantId,
      }),
      tournamentFinish: {
        status: "ABANDONED_NO_HUMAN",
        championTournamentPlayerId: null,
        finishedAt,
        retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
        roomStatus: "CLOSED",
        // roomClosure 缺失：只写 status 会违反 rooms_closed_* CHECK。
      },
    };
    await expect(repo.commitHandBundle(bundle)).rejects.toThrow(/roomClosure/i);
    // 前置校验失败：无任何写入遗留。
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("CREATED");
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("IN_GAME");
    expect(tournament.lastCommittedSequence).toBe(0n);
  });

  it("roomClosure 搭配非 CLOSED roomStatus 被拒绝（关房字段只属于 CLOSED）", async () => {
    const fixture = await createTournamentFixture("Xi");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date();
    const bundle: HandCommitBundle = {
      ...buildBundle({
        tournamentId: fixture.tournamentId,
        handId: randomUUID(),
        handNumber: 1,
        firstSequence: 1n,
        eventCount: 2,
        participantId: fixture.participantId,
      }),
      tournamentFinish: {
        status: "FINISHED",
        championTournamentPlayerId: fixture.participantId,
        finishedAt,
        retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
        roomStatus: "FINISHED",
        roomClosure: {
          // 非 CLOSED 状态写关房字段同样违反 rooms_closed_* CHECK。
          closedAt: finishedAt,
          closedReason: "ABANDONED_NO_HUMAN",
          retentionExpiresAt: new Date(finishedAt.getTime() + 180 * 24 * 3600 * 1000),
        },
      },
    };
    await expect(repo.commitHandBundle(bundle)).rejects.toBeInstanceOf(PersistenceError);
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
  });
});
