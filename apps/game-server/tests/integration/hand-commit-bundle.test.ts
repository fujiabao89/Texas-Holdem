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
    // 真实流程中 Room 队列的 TOURNAMENT_FINISHED 控制面写入先于/伴随 Bundle 落库把
    // 房间置为 FINISHED（先提交后确认）；Bundle 侧的房间写入仅幂等重申该状态。
    await testDb!.database.db.update(rooms).set({ status: "FINISHED" }).where(eq(rooms.id, fixture.roomId));
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

  it("延迟终局 Bundle 不得覆写已推进的房间状态（再来一局竞态，P1）", async () => {
    const fixture = await createTournamentFixture("Iota");
    const repo = createHandCommitRepository(testDb!.database);
    // 时序：控制面已把房间写为 FINISHED → 房主"再来一局"已创建新赛并把房间写回
    // IN_GAME（startTournament 单事务）→ 旧赛的终局 Bundle 才在 PersistenceWriter
    // 积压/重试后落库。新赛（tournamentNo=2）运行中即"已推进"的判据。
    await testDb!.database.db.update(rooms).set({ status: "FINISHED" }).where(eq(rooms.id, fixture.roomId));
    const replayTournamentId = randomUUID();
    await testDb!.database.db.insert(tournaments).values({
      id: replayTournamentId,
      roomId: fixture.roomId,
      tournamentNo: 2,
      status: "IN_GAME",
      configJson: { maxPlayers: 2, startingStack: 1000 },
    });
    await testDb!.database.db.update(rooms).set({ status: "IN_GAME" }).where(eq(rooms.id, fixture.roomId));
    const finishedAt = new Date("2026-01-01T03:00:00Z");
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
      },
    };
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    // 旧赛自身终态与手牌数据完整落库……
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("FINISHED");
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(1);
    // ……但不得把已进入新赛的房间覆写回 FINISHED（内存权威为 IN_GAME）。
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("IN_GAME");
  });

  it("控制面 TOURNAMENT_FINISHED 写失败时终局 Bundle 兜底写 FINISHED（P2）", async () => {
    const fixture = await createTournamentFixture("Kappa");
    const repo = createHandCommitRepository(testDb!.database);
    // 时序：main.ts 对 TOURNAMENT_FINISHED 控制面命令的持久化瞬时失败被记录后丢弃，
    // 房间 DB 残留 IN_GAME（startTournament 已写入）且无新赛 → 本 Bundle 是唯一的
    // FINISHED 落库路径，必须兜底。（fixture 建房初始为 CREATED，显式置为 IN_GAME。）
    await testDb!.database.db.update(rooms).set({ status: "IN_GAME" }).where(eq(rooms.id, fixture.roomId));
    const finishedAt = new Date("2026-01-01T04:00:00Z");
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
      },
    };
    await expect(repo.commitHandBundle(bundle)).resolves.toBe("committed");

    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("FINISHED");
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("FINISHED");
  });

  it("并发开局持锁提交后再放行终局 Bundle：不覆写新赛房间（READ COMMITTED 快照竞态，P1）", async () => {
    const fixture = await createTournamentFixture("Lambda");
    const repo = createHandCommitRepository(testDb!.database);
    // 复现审查描述的精确时序：控制面已写 FINISHED → 再来一局事务插入新赛并把
    // 房间改 IN_GAME（未提交、持有 Room 行锁）→ 旧赛终局 Bundle 到达 rooms
    // 判定并阻塞在行锁上 → 开局事务提交 → Bundle 被放行。修复前：单条 UPDATE
    // 的语句快照看不到刚提交的新赛（EPQ 只重检目标行元组），NOT EXISTS 误放行，
    // 房间被覆写回 FINISHED；修复后：SELECT ... FOR UPDATE 等待开局提交，以
    // 新快照判定、跳过覆写。
    await testDb!.database.db.update(rooms).set({ status: "FINISHED" }).where(eq(rooms.id, fixture.roomId));
    const finishedAt = new Date("2026-01-01T05:00:00Z");
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
      },
    };

    let replayHoldsLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      replayHoldsLock = resolve;
    });
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayPromise = testDb!.database.db.transaction(async (txA) => {
      await txA.insert(tournaments).values({
        id: randomUUID(),
        roomId: fixture.roomId,
        tournamentNo: 2,
        status: "IN_GAME",
        configJson: { maxPlayers: 2, startingStack: 1000 },
      });
      await txA.update(rooms).set({ status: "IN_GAME" }).where(eq(rooms.id, fixture.roomId));
      replayHoldsLock(); // 新赛已插入、Room 行锁已持有，事务保持打开
      await replayGate;
    });
    await lockHeld;

    // 终局 Bundle 阻塞在 Room 行锁上；随后开局事务提交、释放行锁。
    const bundlePromise = repo.commitHandBundle(bundle);
    await new Promise((resolve) => setTimeout(resolve, 600));
    releaseReplay();
    await replayPromise;
    await expect(bundlePromise).resolves.toBe("committed");

    // 旧赛终态完整落库……
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("FINISHED");
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(1);
    // ……但新赛运行中的房间保持 IN_GAME，不得被覆写回 FINISHED。
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("IN_GAME");
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

  it("roomClosure 时间倒挂（retention < closedAt）写入前被拒绝：无任何落库（§5.1 前置校验）", async () => {
    const fixture = await createTournamentFixture("Omicron");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date("2026-01-01T03:00:00Z");
    const closedAt = new Date("2026-01-01T03:00:01Z");
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
          retentionExpiresAt: new Date(closedAt.getTime() - 1000), // 倒挂
        },
      },
    };
    // 写入前拒绝（PersistenceError），而不是整包写入后才被 rooms_retention_check 回滚。
    await expect(repo.commitHandBundle(bundle)).rejects.toThrow(/retentionExpiresAt/);

    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
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
    expect(tournament.status).toBe("IN_GAME");
    expect(tournament.lastCommittedSequence).toBe(0n);
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("CREATED");
    expect(room.closedAt).toBeNull();
    expect(room.retentionExpiresAt).toBeNull();
  });

  it("roomClosure.closedReason 为空串/空白/含控制字符在写入前被拒绝（原因码非自由文本，§5.1）", async () => {
    const fixture = await createTournamentFixture("Pi");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date("2026-01-01T04:00:00Z");
    const closedAt = new Date("2026-01-01T04:00:01Z");
    // 空串/空白能绕过 DB 的 NOT NULL 检查（IS NOT NULL 对空串为真），
    // 控制字符（堆栈/自由文本痕迹）在 PG text 列可正常入库——均须前置拒绝。
    for (const badReason of ["", "   ", "Error: boom\n  at foo (bar.ts:1)"]) {
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
            closedReason: badReason,
            retentionExpiresAt: new Date(closedAt.getTime() + 180 * 24 * 3600 * 1000),
          },
        },
      };
      await expect(repo.commitHandBundle(bundle)).rejects.toThrow(/closedReason/);
      expect(
        await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
      ).toHaveLength(0);
    }
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, fixture.roomId));
    expect(room.status).toBe("CREATED");
  });

  it("tournamentFinish 保留期早于 finishedAt 同样写入前被拒绝（对称防护，§5.3）", async () => {
    const fixture = await createTournamentFixture("Rho");
    const repo = createHandCommitRepository(testDb!.database);
    const finishedAt = new Date("2026-01-01T05:00:00Z");
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
        retentionExpiresAt: new Date(finishedAt.getTime() - 1000), // 倒挂
      },
    };
    await expect(repo.commitHandBundle(bundle)).rejects.toThrow(/retentionExpiresAt/);
    expect(
      await testDb!.database.db.select().from(hands).where(eq(hands.id, bundle.hand.id)),
    ).toHaveLength(0);
    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament.status).toBe("IN_GAME");
    expect(tournament.lastCommittedSequence).toBe(0n);
  });
});
