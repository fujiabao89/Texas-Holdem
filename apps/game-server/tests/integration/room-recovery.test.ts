import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { computePlayerTokenDigest } from "../../src/infrastructure/persistence";
import type { Database, GameTransaction } from "../../src/infrastructure/persistence/database";
import {
  createRoomRecoveryRepository,
  createRoomRepository,
  createTournamentRepository,
  INITIAL_ROOM_REVISION_CEILING,
  ROOM_REVISION_BLOCK_SIZE,
} from "../../src/infrastructure/persistence/repositories";
import { roomPlayers, rooms, tournaments } from "../../src/infrastructure/persistence/schema";
import {
  generateInviteCode,
  randomUUID,
  setupIntegrationDatabase,
  type IntegrationDatabase,
} from "./helpers";

describeTestDatabase("TEX-51 room recovery repository", (context) => {
  let testDb: IntegrationDatabase | undefined;
  const roomConfig = { maxPlayers: 6, startingStack: 1000 };

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  async function createRoom(displayName: string) {
    const roomId = randomUUID();
    const playerId = randomUUID();
    const inviteCode = generateInviteCode();
    const tokenDigest = computePlayerTokenDigest({
      roomId,
      playerId,
      token: "test-token",
      keyId: "v1",
      secret: "test-secret",
    });
    await createRoomRepository(testDb!.database).createRoomWithHost({
      roomId,
      mode: "MULTIPLAYER",
      inviteCode,
      initialStatus: "LOBBY",
      configJson: roomConfig,
      host: { playerId, displayName, tokenDigest, tokenKeyId: "v1" },
    });
    return { roomId, playerId, inviteCode, displayName, tokenDigest };
  }

  async function addMember(roomId: string, displayName: string) {
    const playerId = randomUUID();
    const tokenDigest = computePlayerTokenDigest({
      roomId,
      playerId,
      token: "member-token",
      keyId: "v1",
      secret: "test-secret",
    });
    await createRoomRepository(testDb!.database).insertRoomPlayer({
      roomId,
      playerId,
      displayName,
      displayNameKey: displayName.toLowerCase(),
      kind: "HUMAN",
      tokenDigest,
      tokenKeyId: "v1",
    });
    return { playerId, tokenDigest };
  }

  async function createTournament(
    fixture: Awaited<ReturnType<typeof createRoom>>,
    tournamentNo: number,
    finished = false,
  ) {
    const tournamentId = randomUUID();
    const participantId = randomUUID();
    await createTournamentRepository(testDb!.database).createTournamentWithPlayers({
      tournamentId,
      roomId: fixture.roomId,
      tournamentNo,
      configJson: roomConfig,
      players: [
        {
          id: participantId,
          playerId: fixture.playerId,
          displayName: fixture.displayName,
          seatIndex: 4,
          kind: "HUMAN",
          startingStack: 1000n,
        },
      ],
    });
    if (finished) {
      await testDb!.database.db
        .update(tournaments)
        .set({
          status: "FINISHED",
          finishedAt: new Date("2026-09-12T00:00:00Z"),
          retentionExpiresAt: new Date("2027-03-11T00:00:00Z"),
        })
        .where(eq(tournaments.id, tournamentId));
    }
    return { tournamentId, participantId };
  }

  it("reads ACTIVE identities and private digests, excluding LEFT members and CLOSED rooms", async () => {
    const fixture = await createRoom("RecoveryHost");
    const active = await addMember(fixture.roomId, "ActivePlayer");
    const left = await addMember(fixture.roomId, "LeftPlayer");
    const botId = randomUUID();
    await testDb!.database.db.insert(roomPlayers).values({
      id: botId,
      roomId: fixture.roomId,
      displayName: "RecoveryBot",
      displayNameKey: "recoverybot",
      kind: "BOT",
      status: "ACTIVE",
      tokenDigest: null,
      tokenKeyId: null,
    });
    await createRoomRepository(testDb!.database).markRoomPlayerLeft(
      fixture.roomId,
      left.playerId,
      "USER_LEFT",
      new Date(),
    );
    const closed = await createRoom("ClosedHost");
    await createRoomRepository(testDb!.database).setRoomStatus(closed.roomId, "CLOSED", {
      closedReason: "ABANDONED_NO_HUMAN",
      closedAt: new Date("2026-09-12T00:00:00Z"),
      retentionExpiresAt: new Date("2027-03-11T00:00:00Z"),
    });

    const records = await createRoomRecoveryRepository(testDb!.database).listRecoverableRooms();
    const restored = records.find((record) => record.roomId === fixture.roomId)!;
    expect(records.some((record) => record.roomId === closed.roomId)).toBe(false);
    expect(restored).toMatchObject({
      status: "LOBBY",
      inviteCode: fixture.inviteCode,
      hostPlayerId: fixture.playerId,
      configJson: roomConfig,
      tournamentCount: 0,
      tournaments: [],
    });
    expect(restored.members.map((member) => member.playerId).sort()).toEqual(
      [fixture.playerId, active.playerId, botId].sort(),
    );
    expect(restored.members.find((member) => member.playerId === active.playerId)).toMatchObject({
      tokenDigest: active.tokenDigest,
      tokenKeyId: "v1",
      joinedAt: expect.any(Date),
    });
    expect(restored.members.find((member) => member.playerId === botId)).toMatchObject({
      tokenDigest: null,
      tokenKeyId: null,
    });
    expect(
      restored.members.every(
        (member) =>
          !("ready" in member) &&
          !("seat" in member) &&
          !("connectionStatus" in member) &&
          !("token" in member),
      ),
    ).toBe(true);
  });

  it("uses the maximum historical number and returns latest plus lagging IN_GAME tournaments with locked seats", async () => {
    const fixture = await createRoom("HistoryHost");
    await createTournament(fixture, 1, true);
    const delayed = await createTournament(fixture, 5);
    const latest = await createTournament(fixture, 9, true);
    await createRoomRepository(testDb!.database).setRoomStatus(fixture.roomId, "FINISHED");

    const records = await createRoomRecoveryRepository(testDb!.database).listRecoverableRooms();
    const record = records.find((room) => room.roomId === fixture.roomId)!;
    expect(record.tournamentCount).toBe(9);
    expect(record.tournaments.map((tournament) => tournament.tournamentId)).toEqual([
      latest.tournamentId,
      delayed.tournamentId,
    ]);
    expect(record.tournaments[0]).toMatchObject({
      tournamentNo: 9,
      status: "FINISHED",
      configJson: roomConfig,
      lastCommittedSequence: 0n,
      players: [
        {
          id: latest.participantId,
          playerId: fixture.playerId,
          seatIndex: 4,
          kind: "HUMAN",
          startingStack: 1000n,
        },
      ],
    });
  });

  it("preserves FINISHED Room plus latest IN_GAME facts for startup reconciliation", async () => {
    const fixture = await createRoom("DelayedFinish");
    const tournament = await createTournament(fixture, 3);
    await createRoomRepository(testDb!.database).setRoomStatus(fixture.roomId, "FINISHED");
    const records = await createRoomRecoveryRepository(testDb!.database).listRecoverableRooms();
    expect(records.find((room) => room.roomId === fixture.roomId)).toMatchObject({
      status: "FINISHED",
      tournaments: [{ tournamentId: tournament.tournamentId, status: "IN_GAME" }],
    });
  });

  it("returns malformed config and missing ACTIVE host without aborting healthy room reads", async () => {
    const damaged = await createRoom("DamagedHost");
    const healthy = await createRoom("HealthyHost");
    await testDb!.database.db
      .update(rooms)
      .set({ configJson: { unsupported: true }, hostPlayerId: null })
      .where(eq(rooms.id, damaged.roomId));
    await createRoomRepository(testDb!.database).markRoomPlayerLeft(
      damaged.roomId,
      damaged.playerId,
      "USER_LEFT",
      new Date(),
    );
    const records = await createRoomRecoveryRepository(testDb!.database).listRecoverableRooms();
    expect(records.find((room) => room.roomId === damaged.roomId)).toMatchObject({
      configJson: { unsupported: true },
      hostPlayerId: null,
      members: [],
    });
    expect(records.find((room) => room.roomId === healthy.roomId)).toMatchObject({
      hostPlayerId: healthy.playerId,
      configJson: roomConfig,
    });
  });

  it("reads one repeatable, read-only snapshot while another connection commits membership changes", async () => {
    const fixture = await createRoom("SnapshotHost");
    let newMemberId: string | undefined;
    let injected = false;
    const database: Database = {
      ...testDb!.database,
      withTransaction<T>(fn: (tx: GameTransaction) => Promise<T>): Promise<T> {
        return testDb!.database.withTransaction(async (tx) => {
          // Execute real SQL throughout. After isolation setup, establish the read
          // snapshot, commit on another connection, then allow the recovery reads.
          const intercepted = new Proxy(tx, {
            get(target, property) {
              if (property === "execute") {
                return async (...args: Parameters<GameTransaction["execute"]>) => {
                  const result = await target.execute(...args);
                  if (!injected) {
                    injected = true;
                    const isolation = await target.execute(sql`SHOW transaction_isolation`);
                    const readOnly = await target.execute(sql`SHOW transaction_read_only`);
                    expect(isolation.rows[0]).toEqual({ transaction_isolation: "repeatable read" });
                    expect(readOnly.rows[0]).toEqual({ transaction_read_only: "on" });
                    await target
                      .select({ id: rooms.id })
                      .from(rooms)
                      .where(eq(rooms.id, fixture.roomId));
                    newMemberId = (await addMember(fixture.roomId, "ConcurrentJoin")).playerId;
                  }
                  return result;
                };
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return fn(intercepted);
        });
      },
    };
    const first = await createRoomRecoveryRepository(database).listRecoverableRooms();
    expect(injected).toBe(true);
    expect(newMemberId).toBeDefined();
    expect(
      first
        .find((room) => room.roomId === fixture.roomId)!
        .members.map((member) => member.playerId),
    ).toEqual([fixture.playerId]);
    const second = await createRoomRecoveryRepository(testDb!.database).listRecoverableRooms();
    expect(
      second
        .find((room) => room.roomId === fixture.roomId)!
        .members.some((member) => member.playerId === newMemberId),
    ).toBe(true);
  });

  it("defaults new Rooms to the initial revision ceiling and reserves strictly increasing restart ranges", async () => {
    const fixture = await createRoom("RevisionHost");
    const repo = createRoomRecoveryRepository(testDb!.database);
    const [created] = await testDb!.database.db
      .select({ ceiling: rooms.roomRevisionCeiling })
      .from(rooms)
      .where(eq(rooms.id, fixture.roomId));
    expect(created!.ceiling).toBe(BigInt(INITIAL_ROOM_REVISION_CEILING));
    const first = await repo.reserveRoomRevision(fixture.roomId);
    const second = await repo.reserveRoomRevision(fixture.roomId);
    expect(first).toEqual({ initial: 4_294_967_296, ceiling: 8_589_934_591 });
    expect(second).toEqual({ initial: 8_589_934_592, ceiling: 12_884_901_887 });
    expect(second.initial).toBe(first.ceiling + 1);
  });

  it("concurrent revision reservations cannot hand out overlapping ranges", async () => {
    const fixture = await createRoom("ConcurrentRange");
    const repo = createRoomRecoveryRepository(testDb!.database);
    const allocated = await Promise.all([
      repo.reserveRoomRevision(fixture.roomId),
      repo.reserveRoomRevision(fixture.roomId),
    ]);
    allocated.sort((left, right) => left.initial - right.initial);
    expect(allocated[0]!.initial).toBe(ROOM_REVISION_BLOCK_SIZE);
    expect(allocated[1]!.initial).toBe(allocated[0]!.ceiling + 1);
    expect(allocated[1]!.ceiling - allocated[1]!.initial + 1).toBe(ROOM_REVISION_BLOCK_SIZE);
  });

  it("reserves the final safe range then refuses exhaustion without advancing the persisted ceiling", async () => {
    const fixture = await createRoom("FinalRangeHost");
    const repo = createRoomRecoveryRepository(testDb!.database);
    await testDb!.database.db
      .update(rooms)
      .set({
        roomRevisionCeiling: BigInt(Number.MAX_SAFE_INTEGER) - BigInt(ROOM_REVISION_BLOCK_SIZE),
      })
      .where(eq(rooms.id, fixture.roomId));
    expect(await repo.reserveRoomRevision(fixture.roomId)).toEqual({
      initial: Number.MAX_SAFE_INTEGER - ROOM_REVISION_BLOCK_SIZE + 1,
      ceiling: Number.MAX_SAFE_INTEGER,
    });
    await expect(repo.reserveRoomRevision(fixture.roomId)).rejects.toThrow(
      "ROOM_REVISION_RESERVATION_FAILED",
    );
    const [after] = await testDb!.database.db
      .select({ ceiling: rooms.roomRevisionCeiling })
      .from(rooms)
      .where(eq(rooms.id, fixture.roomId));
    expect(after!.ceiling).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("does not reserve revisions for missing or CLOSED Rooms", async () => {
    const fixture = await createRoom("ClosedRangeHost");
    const repo = createRoomRecoveryRepository(testDb!.database);
    await createRoomRepository(testDb!.database).setRoomStatus(fixture.roomId, "CLOSED", {
      closedReason: "ABANDONED_NO_HUMAN",
      closedAt: new Date("2026-09-12T00:00:00Z"),
      retentionExpiresAt: new Date("2027-03-11T00:00:00Z"),
    });
    await expect(repo.reserveRoomRevision(fixture.roomId)).rejects.toThrow(
      "ROOM_REVISION_RESERVATION_FAILED",
    );
    await expect(repo.reserveRoomRevision(randomUUID())).rejects.toThrow(
      "ROOM_REVISION_RESERVATION_FAILED",
    );
    const [after] = await testDb!.database.db
      .select({ ceiling: rooms.roomRevisionCeiling })
      .from(rooms)
      .where(eq(rooms.id, fixture.roomId));
    expect(after!.ceiling).toBe(BigInt(INITIAL_ROOM_REVISION_CEILING));
  });

  it.each([4_294_967_294n, 9_007_199_254_740_992n])(
    "migration CHECK refuses an out-of-range ceiling %s",
    async (ceiling) => {
      const fixture = await createRoom("InvalidRangeHost");
      await expect(
        testDb!.database.db
          .update(rooms)
          .set({ roomRevisionCeiling: ceiling })
          .where(eq(rooms.id, fixture.roomId)),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "rooms_room_revision_ceiling_check" },
      });
    },
  );
});
