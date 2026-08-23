import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import {
  generateInviteCode,
  randomUUID,
  setupIntegrationDatabase,
  type IntegrationDatabase,
} from "./helpers";
import { computePlayerTokenDigest } from "../../src/infrastructure/persistence/player-token";
import {
  createRoomRepository,
  createTournamentRepository,
} from "../../src/infrastructure/persistence/repositories";
import { rooms, roomPlayers, tournaments, tournamentPlayers } from "../../src/infrastructure/persistence/schema";

/**
 * 控制面事务完整性（docs/03-data-model.md §7.2、任务测试项 2）：
 * Room + 首个 Host、Tournament + locked players 必须各自整体提交或整体回滚。
 */

describeTestDatabase("control plane: 原子写入", (context) => {
  let testDb: IntegrationDatabase | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  function makeRoomFixture(displayName = "Host") {
    const roomId = randomUUID();
    const playerId = randomUUID();
    return {
      input: {
        roomId,
        mode: "MULTIPLAYER" as const,
        inviteCode: generateInviteCode(),
        configJson: { maxPlayers: 6, startingStack: 1000 },
        host: {
          playerId,
          displayName,
          tokenDigest: computePlayerTokenDigest({
            roomId,
            playerId,
            token: "token-abc",
            keyId: "k1",
            secret: "secret",
          }),
          tokenKeyId: "k1",
        },
      },
    };
  }

  it("Room + 首个 Host 在一个事务内提交（含 DEFERRABLE 复合外键回填）", async () => {
    const repo = createRoomRepository(testDb!.database);
    const { input } = makeRoomFixture("Alice");
    await repo.createRoomWithHost(input);

    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, input.roomId));
    expect(room).toBeDefined();
    expect(room.hostPlayerId).toBe(input.host.playerId);
    expect(room.status).toBe("CREATED");

    const [player] = await testDb!.database.db
      .select()
      .from(roomPlayers)
      .where(eq(roomPlayers.id, input.host.playerId));
    expect(player).toBeDefined();
    expect(player.roomId).toBe(input.roomId);
    expect(player.displayName).toBe("Alice");
    expect(player.tokenDigest?.length).toBe(32);
    expect(player.tokenKeyId).toBe("k1");
    expect(player.status).toBe("ACTIVE");
  });

  it("Host 写入失败时 Room 一并回滚（昵称非法），不留半房间", async () => {
    const repo = createRoomRepository(testDb!.database);
    const { input } = makeRoomFixture("Bad\tName");
    await expect(repo.createRoomWithHost(input)).rejects.toThrow();
    const rows = await testDb!.database.db
      .select()
      .from(rooms)
      .where(eq(rooms.id, input.roomId));
    expect(rows).toHaveLength(0);
  });

  it("同一 Room 内规范化昵称重名被拒绝（display_name_key 唯一）", async () => {
    const repo = createRoomRepository(testDb!.database);
    const first = makeRoomFixture("Alice");
    await repo.createRoomWithHost(first.input);
    // 二号成员走直接 SQL（加入接口属 TEX-19），仅验证唯一约束。
    await expect(
      testDb!.database.db.insert(roomPlayers).values({
        id: randomUUID(),
        roomId: first.input.roomId,
        displayName: "ＡＬＩＣＥ", // NFKC 归一后与 Alice 同 key
        displayNameKey: "ａｌｉｃｅ".normalize("NFKC").toLowerCase(),
        kind: "HUMAN",
        tokenDigest: Buffer.alloc(32, 1),
        tokenKeyId: "k1",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } }); // unique_violation
  });

  it("Tournament + locked players 一个事务提交，last_committed_sequence 从 0 开始", async () => {
    const roomRepo = createRoomRepository(testDb!.database);
    const tournamentRepo = createTournamentRepository(testDb!.database);
    const { input } = makeRoomFixture("Bob");
    await roomRepo.createRoomWithHost(input);

    const tournamentId = randomUUID();
    const playerIds = [randomUUID(), randomUUID()];
    // Carol 先加入房间（BOT 成员身份，无凭证），真实流程中真人加入属 TEX-19。
    await testDb!.database.db.insert(roomPlayers).values({
      id: playerIds[1],
      roomId: input.roomId,
      displayName: "Carol",
      displayNameKey: "carol",
      kind: "BOT",
      status: "ACTIVE",
    });
    await tournamentRepo.createTournamentWithPlayers({
      tournamentId,
      roomId: input.roomId,
      tournamentNo: 1,
      configJson: { maxPlayers: 2, startingStack: 500 },
      players: [
        {
          id: playerIds[0],
          playerId: input.host.playerId,
          displayName: "Bob",
          seatIndex: 0,
          kind: "HUMAN",
          startingStack: 500n,
        },
        {
          id: playerIds[1],
          playerId: playerIds[1],
          displayName: "Carol",
          seatIndex: 3,
          kind: "HUMAN",
          startingStack: 500n,
        },
      ],
    });

    const [tournament] = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    expect(tournament.status).toBe("IN_GAME");
    expect(tournament.lastCommittedSequence).toBe(0n);

    const participants = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.tournamentId, tournamentId));
    expect(participants).toHaveLength(2);
    expect(participants.map((p) => p.seatIndex).sort()).toEqual([0, 3]);
  });

  it("Tournament 参赛者写入失败时整体回滚（座位越界），不留半开比赛", async () => {
    const roomRepo = createRoomRepository(testDb!.database);
    const tournamentRepo = createTournamentRepository(testDb!.database);
    const { input } = makeRoomFixture("Dave");
    await roomRepo.createRoomWithHost(input);

    const tournamentId = randomUUID();
    await expect(
      tournamentRepo.createTournamentWithPlayers({
        tournamentId,
        roomId: input.roomId,
        tournamentNo: 1,
        configJson: {},
        players: [
          {
            id: randomUUID(),
            playerId: input.host.playerId,
            displayName: "Dave",
            seatIndex: 10, // 越界：CHECK seat_index BETWEEN 0 AND 9
            kind: "HUMAN",
            startingStack: 500n,
          },
        ],
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } }); // check_violation

    const rows = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    expect(rows).toHaveLength(0);
  });

  it("Tournament 参赛者昵称快照同样过校验（非法昵称整体回滚，无 DB CHECK 兜底）", async () => {
    const roomRepo = createRoomRepository(testDb!.database);
    const tournamentRepo = createTournamentRepository(testDb!.database);
    const { input } = makeRoomFixture("Eve");
    await roomRepo.createRoomWithHost(input);

    const tournamentId = randomUUID();
    await expect(
      tournamentRepo.createTournamentWithPlayers({
        tournamentId,
        roomId: input.roomId,
        tournamentNo: 1,
        configJson: {},
        players: [
          {
            id: randomUUID(),
            playerId: input.host.playerId,
            displayName: "Bad\tName", // 控制字符：入库前校验拒绝
            seatIndex: 0,
            kind: "HUMAN",
            startingStack: 500n,
          },
        ],
      }),
    ).rejects.toThrow(/display name/);

    const rows = await testDb!.database.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    expect(rows).toHaveLength(0);
    const participants = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.tournamentId, tournamentId));
    expect(participants).toHaveLength(0);
  });
});
