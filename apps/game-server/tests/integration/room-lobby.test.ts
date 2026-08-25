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
import { createRoomRepository } from "../../src/infrastructure/persistence/repositories";
import {
  rooms,
  roomPlayers,
  tournaments,
  tournamentPlayers,
} from "../../src/infrastructure/persistence/schema";

/**
 * TEX-19 Lobby 控制面写操作（docs/03-data-model.md §5.1/§5.2/§5.3/§7.2）：
 * 加入、状态迁移、Host 转移、配置、离开、开局均复用 RoomRepository 原子事务边界，
 * 不新建表/迁移。缺真实数据库配置时整组受控跳过（§2.1）。
 */

describeTestDatabase("room lobby: 控制面写操作", (context) => {
  let testDb: IntegrationDatabase | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
  });

  afterAll(async () => {
    await testDb?.end();
  });

  async function createRoom(displayName = "Host") {
    const repo = createRoomRepository(testDb!.database);
    const roomId = randomUUID();
    const playerId = randomUUID();
    const digest = computePlayerTokenDigest({
      roomId,
      playerId,
      token: "token-abc",
      keyId: "k1",
      secret: "secret",
    });
    const inviteCode = generateInviteCode();
    await repo.createRoomWithHost({
      roomId,
      mode: "MULTIPLAYER",
      inviteCode,
      configJson: { maxPlayers: 4, startingStack: 1000 },
      host: { playerId, displayName, tokenDigest: digest, tokenKeyId: "k1" },
    });
    return { repo, roomId, playerId, inviteCode };
  }

  it("insertRoomPlayer 加入成员：ACTIVE、昵称 key 唯一、token 摘要 32 字节", async () => {
    const { repo, roomId } = await createRoom();
    const joinId = randomUUID();
    const digest = computePlayerTokenDigest({ roomId, playerId: joinId, token: "token-b", keyId: "k1", secret: "secret" });
    await repo.insertRoomPlayer({
      roomId,
      playerId: joinId,
      displayName: "Alice",
      displayNameKey: "alice",
      kind: "HUMAN",
      tokenDigest: digest,
      tokenKeyId: "k1",
    });
    const [row] = await testDb!.database.db.select().from(roomPlayers).where(eq(roomPlayers.id, joinId));
    expect(row).toBeDefined();
    expect(row.roomId).toBe(roomId);
    expect(row.displayNameKey).toBe("alice");
    expect(row.status).toBe("ACTIVE");
    expect(row.tokenDigest?.length).toBe(32);
  });

  it("setRoomStatus 迁移到 IN_GAME 与 CLOSED；CLOSED 写齐关闭元数据", async () => {
    const { repo, roomId } = await createRoom();
    await repo.setRoomStatus(roomId, "IN_GAME");
    let [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.status).toBe("IN_GAME");

    const closedAt = new Date();
    await repo.setRoomStatus(roomId, "CLOSED", {
      closedReason: "ABANDONED_NO_HUMAN",
      closedAt,
      retentionExpiresAt: new Date(closedAt.getTime() + 180 * 24 * 3600 * 1000),
    });
    [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.status).toBe("CLOSED");
    expect(room.closedReason).toBe("ABANDONED_NO_HUMAN");
    expect(room.closedAt).not.toBeNull();
    expect(room.retentionExpiresAt).not.toBeNull();
  });

  it("setRoomHost / updateRoomConfig / markRoomPlayerLeft 生效", async () => {
    const { repo, roomId, playerId } = await createRoom();
    await repo.setRoomHost(roomId, null);
    let [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.hostPlayerId).toBeNull();

    await repo.updateRoomConfig(roomId, { maxPlayers: 6, startingStack: 500 });
    [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.configJson).toEqual({ maxPlayers: 6, startingStack: 500 });

    const leftAt = new Date();
    await repo.markRoomPlayerLeft(roomId, playerId, "USER_LEFT", leftAt);
    const [left] = await testDb!.database.db.select().from(roomPlayers).where(eq(roomPlayers.id, playerId));
    expect(left.status).toBe("LEFT");
    expect(left.leftReason).toBe("USER_LEFT");
    expect(left.leftAt).not.toBeNull();
  });

  it("startTournament 单事务写 Tournament + locked players + Room→IN_GAME", async () => {
    const { repo, roomId, playerId } = await createRoom();
    const tournamentId = randomUUID();
    const lockedPlayerId = randomUUID();
    // 锁定参赛者必须是本 Room 的既有成员（tournament_players_player_fk 引用 room_players），先入库。
    const alicePlayerId = randomUUID();
    await repo.insertRoomPlayer({
      roomId,
      playerId: alicePlayerId,
      displayName: "Alice",
      displayNameKey: "alice",
      kind: "HUMAN",
      tokenDigest: computePlayerTokenDigest({
        roomId,
        playerId: alicePlayerId,
        token: "token-alice",
        keyId: "k1",
        secret: "secret",
      }),
      tokenKeyId: "k1",
    });
    await repo.startTournament({
      roomId,
      tournamentId,
      tournamentNo: 1,
      configJson: { maxPlayers: 2, startingStack: 1000 },
      players: [
        { id: lockedPlayerId, playerId, displayName: "Host", seatIndex: 0, kind: "HUMAN", startingStack: 1000n },
        {
          id: randomUUID(),
          playerId: alicePlayerId,
          displayName: "Alice",
          seatIndex: 1,
          kind: "HUMAN",
          startingStack: 1000n,
        },
      ],
    });
    const [tournament] = await testDb!.database.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    expect(tournament).toBeDefined();
    expect(tournament.status).toBe("IN_GAME");
    expect(tournament.lastCommittedSequence).toBe(0n);
    const [locked] = await testDb!.database.db
      .select()
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.id, lockedPlayerId));
    expect(locked.playerId).toBe(playerId);
    expect(locked.seatIndex).toBe(0);
    const [room] = await testDb!.database.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.status).toBe("IN_GAME");
  });
});
