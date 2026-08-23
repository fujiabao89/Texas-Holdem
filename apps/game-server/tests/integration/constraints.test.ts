import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { generateInviteCode, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { computePlayerTokenDigest } from "../../src/infrastructure/persistence";
import {
  createRoomRepository,
  createTournamentRepository,
} from "../../src/infrastructure/persistence/repositories";
import {
  hands,
  roomPlayers,
  rooms,
  tournaments,
  tournamentPlayers,
} from "../../src/infrastructure/persistence/schema";

/**
 * 数据库约束验收（docs/03-data-model.md §15.2，任务测试项 6）：
 * FK/复合 FK/CHECK/唯一约束的"合法行成功 + 越界行失败"。
 * 断言用 PostgreSQL 错误码（Drizzle 把 pg 错误包装在 cause 中）：
 * 23503 FK violation / 23505 unique violation / 23514 check violation。
 */

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

describeTestDatabase("constraints: 合法行成功、越界行失败", (context) => {
  let testDb: IntegrationDatabase | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  // 构造一对 Room + 两个成员 + 一个 Tournament 的合法基线。
  async function createBaseline() {
    const roomId = randomUUID();
    const hostId = randomUUID();
    const guestId = randomUUID();
    await createRoomRepository(testDb!.database).createRoomWithHost({
      roomId,
      mode: "MULTIPLAYER",
      inviteCode: generateInviteCode(),
      configJson: {},
      host: {
        playerId: hostId,
        displayName: "Host",
        tokenDigest: computePlayerTokenDigest({
          roomId,
          playerId: hostId,
          token: "t",
          keyId: "k1",
          secret: "s",
        }),
        tokenKeyId: "k1",
      },
    });
    await testDb!.database.db.insert(roomPlayers).values({
      id: guestId,
      roomId,
      displayName: "Guest",
      displayNameKey: "guest",
      kind: "BOT",
      status: "ACTIVE",
    });
    const bystanderId = randomUUID();
    await testDb!.database.db.insert(roomPlayers).values({
      id: bystanderId,
      roomId,
      displayName: "Bystander",
      displayNameKey: "bystander",
      kind: "BOT",
      status: "ACTIVE",
    });
    const otherRoomId = randomUUID();
    const otherHostId = randomUUID();
    await createRoomRepository(testDb!.database).createRoomWithHost({
      roomId: otherRoomId,
      mode: "MULTIPLAYER",
      inviteCode: generateInviteCode(),
      configJson: {},
      host: {
        playerId: otherHostId,
        displayName: "OtherHost",
        tokenDigest: computePlayerTokenDigest({
          roomId: otherRoomId,
          playerId: otherHostId,
          token: "t",
          keyId: "k1",
          secret: "s",
        }),
        tokenKeyId: "k1",
      },
    });
    const tournamentId = randomUUID();
    const hostParticipantId = randomUUID();
    await createTournamentRepository(testDb!.database).createTournamentWithPlayers({
      tournamentId,
      roomId,
      tournamentNo: 1,
      configJson: {},
      players: [
        {
          id: hostParticipantId,
          playerId: hostId,
          displayName: "Host",
          seatIndex: 0,
          kind: "HUMAN",
          startingStack: 1000n,
        },
        {
          id: randomUUID(),
          playerId: guestId,
          displayName: "Guest",
          seatIndex: 1,
          kind: "BOT",
          startingStack: 1000n,
        },
      ],
    });
    return {
      roomId,
      hostId,
      guestId,
      bystanderId,
      otherRoomId,
      otherHostId,
      tournamentId,
      hostParticipantId,
    };
  }

  it("跨 Room 玩家不能成为参赛者（复合 FK (room_id, player_id)）", async () => {
    const baseline = await createBaseline();
    await expect(
      testDb!.database.db.insert(tournamentPlayers).values({
        id: randomUUID(),
        tournamentId: baseline.tournamentId,
        roomId: baseline.roomId,
        playerId: baseline.otherHostId, // 属于另一个 Room
        displayName: "Intruder",
        seatIndex: 5,
        kind: "HUMAN",
        startingStack: 1000n,
        pokerStatus: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: FK_VIOLATION } });
  });

  it("Tournament 必须挂在所属 Room 上（复合 FK (tournament_id, room_id)）", async () => {
    const baseline = await createBaseline();
    await expect(
      testDb!.database.db.insert(tournamentPlayers).values({
        id: randomUUID(),
        tournamentId: baseline.tournamentId,
        roomId: baseline.otherRoomId, // 与 Tournament 的 room 不一致
        playerId: baseline.bystanderId, // 未参赛者，避免先触发 player 唯一冲突
        displayName: "Mismatch",
        seatIndex: 6,
        kind: "BOT",
        startingStack: 1000n,
        pokerStatus: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: FK_VIOLATION } });
  });

  it("同 Tournament 内 seat/player/rank 唯一", async () => {
    const baseline = await createBaseline();
    // seat 冲突（seat 0 已占用）。
    await expect(
      testDb!.database.db.insert(tournamentPlayers).values({
        id: randomUUID(),
        tournamentId: baseline.tournamentId,
        roomId: baseline.roomId,
        playerId: randomUUID(),
        displayName: "SeatClone",
        seatIndex: 0,
        kind: "BOT",
        startingStack: 100n,
        pokerStatus: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
    // 同一玩家重复参赛。
    await expect(
      testDb!.database.db.insert(tournamentPlayers).values({
        id: randomUUID(),
        tournamentId: baseline.tournamentId,
        roomId: baseline.roomId,
        playerId: baseline.hostId,
        displayName: "Twice",
        seatIndex: 7,
        kind: "HUMAN",
        startingStack: 100n,
        pokerStatus: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
    // rank 重复（先把两名参赛者都设置 rank=1）。
    await testDb!.database.db
      .update(tournamentPlayers)
      .set({ rank: 1 })
      .where(eq(tournamentPlayers.id, baseline.hostParticipantId));
    await expect(
      testDb!.database.db
        .update(tournamentPlayers)
        .set({ rank: 1 })
        .where(eq(tournamentPlayers.tournamentId, baseline.tournamentId)),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
  });

  it("枚举与 nullable 矛盾的行被 CHECK 拒绝（§5.9）", async () => {
    const baseline = await createBaseline();
    // BOT 带凭证。
    await expect(
      testDb!.database.db.insert(roomPlayers).values({
        id: randomUUID(),
        roomId: baseline.roomId,
        displayName: "BotWithToken",
        displayNameKey: "botwithtoken",
        kind: "BOT",
        tokenDigest: Buffer.alloc(32, 9),
        tokenKeyId: "k1",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // HUMAN 无凭证。
    await expect(
      testDb!.database.db.insert(roomPlayers).values({
        id: randomUUID(),
        roomId: baseline.roomId,
        displayName: "HumanNoToken",
        displayNameKey: "humannotoken",
        kind: "HUMAN",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // LEFT 但没有 left_at/left_reason。
    await expect(
      testDb!.database.db.insert(roomPlayers).values({
        id: randomUUID(),
        roomId: baseline.roomId,
        displayName: "GhostLeft",
        displayNameKey: "ghostleft",
        kind: "BOT",
        status: "LEFT",
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // SINGLE_PLAYER 却带邀请码。
    await expect(
      testDb!.database.db.insert(rooms).values({
        id: randomUUID(),
        mode: "SINGLE_PLAYER",
        inviteCode: "ABC234",
        status: "CREATED",
        configJson: {},
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // MULTIPLAYER 邀请码缺失（§5.1 必填）：NULL ~ 正则为 NULL，CHECK 的三值
    // 逻辑会放行，必须由 IS NOT NULL 显式拒绝。
    await expect(
      testDb!.database.db.insert(rooms).values({
        id: randomUUID(),
        mode: "MULTIPLAYER",
        inviteCode: null,
        status: "CREATED",
        configJson: {},
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // MULTIPLAYER 邀请码字符集非法（含 0/O/1/I/L、长度不对或小写）。
    for (const badCode of ["ABC230", "ABCO34", "ABCI34", "ABCL34", "ABC1", "ABCD345", "abcd34"]) {
      await expect(
        testDb!.database.db.insert(rooms).values({
          id: randomUUID(),
          mode: "MULTIPLAYER",
          inviteCode: badCode,
          status: "CREATED",
          configJson: {},
        }),
      ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    }
    // CLOSED 但缺 closed_reason / closed_at / retention。
    await expect(
      testDb!.database.db.insert(rooms).values({
        id: randomUUID(),
        mode: "MULTIPLAYER",
        inviteCode: generateInviteCode(),
        status: "CLOSED",
        configJson: {},
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // 非 CLOSED 却带 closed_at。
    await expect(
      testDb!.database.db.insert(rooms).values({
        id: randomUUID(),
        mode: "MULTIPLAYER",
        inviteCode: generateInviteCode(),
        status: "LOBBY",
        configJson: {},
        closedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // FINISHED Tournament 无 finished_at。
    await expect(
      testDb!.database.db.insert(tournaments).values({
        id: randomUUID(),
        roomId: baseline.roomId,
        tournamentNo: 2,
        status: "FINISHED",
        configJson: {},
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // 负数 last_committed_sequence。
    await expect(
      testDb!.database.db.insert(tournaments).values({
        id: randomUUID(),
        roomId: baseline.roomId,
        tournamentNo: 3,
        status: "IN_GAME",
        configJson: {},
        lastCommittedSequence: -1n,
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it("hands 数值边界与公共牌长度约束", async () => {
    const baseline = await createBaseline();
    const baseHand = {
      tournamentId: baseline.tournamentId,
      handNumber: 1,
      dealerSeat: 0,
      sbSeat: 1,
      bbSeat: 2,
      blindLevelIndex: 0,
      smallBlind: 10n,
      bigBlind: 20n,
      communityCards: [],
      summary: {},
      endReason: "ALL_FOLDED" as const,
    };
    // 合法行成功。
    await expect(testDb!.database.db.insert(hands).values({ id: randomUUID(), ...baseHand })).resolves.toBeDefined();
    // big_blind <= small_blind。
    await expect(
      testDb!.database.db.insert(hands).values({
        id: randomUUID(),
        ...baseHand,
        handNumber: 2,
        bigBlind: 10n,
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // 座位越界。
    await expect(
      testDb!.database.db.insert(hands).values({
        id: randomUUID(),
        ...baseHand,
        handNumber: 3,
        dealerSeat: 10,
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // 公共牌 6 张。
    await expect(
      testDb!.database.db.insert(hands).values({
        id: randomUUID(),
        ...baseHand,
        handNumber: 4,
        communityCards: ["AS", "KS", "QS", "JS", "TS", "9S"],
      }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    // hand_number 从 1 开始。
    await expect(
      testDb!.database.db.insert(hands).values({ id: randomUUID(), ...baseHand, handNumber: 0 }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});
