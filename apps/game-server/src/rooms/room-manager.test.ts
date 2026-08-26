import { describe, expect, it } from "vitest";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { RoomDomainError } from "./room-errors";
import type { IdSource } from "./id-source";
import { createRoomManager } from "./room-manager";
import { fakePersistence, fakeRoomRepository } from "./test-support";

const TOKEN_SECRET = "test-secret";
const TOKEN_KEY_ID = "k1";

function makeConfig(): TournamentConfig {
  return {
    maxPlayers: 4,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 30,
    timeBank: 60,
  };
}

function fakeIds(): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    // 递增字节序列：保证两次创建的邀请码互不相同（rejection sampling 会跳过 >= 248）
    randomBytes: (count) => Uint8Array.from({ length: count }, () => (n = (n + 1) % 256)),
    now: () => 1000,
  };
}

function makeManager() {
  const roomRepository = fakeRoomRepository();
  const persistence = fakePersistence();
  const manager = createRoomManager({
    persistence,
    roomRepository,
    ids: fakeIds(),
    tokenSecret: TOKEN_SECRET,
    tokenKeyId: TOKEN_KEY_ID,
  });
  return { manager, roomRepository, persistence };
}

describe("RoomManager", () => {
  it("创建房间：创建者即 Host、返回 roomId/playerId/playerToken 与 LOBBY 快照", async () => {
    const { manager } = makeManager();
    const session = await manager.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: makeConfig(),
    });
    expect(session.playerToken).toHaveLength(43);
    expect(session.roomSnapshot.status).toBe("LOBBY");
    expect(session.roomSnapshot.hostPlayerId).toBe(session.playerId);
    expect(session.roomSnapshot.players[0]?.playerId).toBe(session.playerId);
    expect(session.roomSnapshot.inviteCode).toMatch(/^[A-HJKMNPQRSTUVWXYZ2-9]{6}$/);
  });

  it("加入房间：返回新身份与更新后的快照；无效邀请码拒绝 INVALID_INVITE_CODE", async () => {
    const { manager } = makeManager();
    const creator = await manager.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: makeConfig(),
    });
    const joined = await manager.joinRoom({
      inviteCode: creator.roomSnapshot.inviteCode!,
      displayName: "Alice",
      displayNameKey: "alice",
    });
    expect(joined.roomId).toBe(creator.roomId);
    expect(joined.playerToken).toHaveLength(43);
    expect(joined.roomSnapshot.players).toHaveLength(2);
    expect(joined.roomSnapshot.players.some((p) => p.playerId === joined.playerId)).toBe(true);
    await expect(
      manager.joinRoom({ inviteCode: "ZZZZZZ", displayName: "Bob", displayNameKey: "bob" }),
    ).rejects.toThrowError(new RoomDomainError("INVALID_INVITE_CODE"));
  });

  it("鉴权：由 token 摘要反查 playerId，错误 token 拒绝 AUTH_FAILED，未知房间拒绝 ROOM_NOT_FOUND", async () => {
    const { manager } = makeManager();
    const creator = await manager.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: makeConfig(),
    });
    expect(manager.authenticate(creator.roomId, creator.playerToken)).toBe(creator.playerId);
    expect(() => manager.authenticate(creator.roomId, "wrong-token-wrong-token-wrong")).toThrowError(
      new RoomDomainError("AUTH_FAILED"),
    );
    expect(() => manager.authenticate("unknown-room", creator.playerToken)).toThrowError(
      new RoomDomainError("ROOM_NOT_FOUND"),
    );
  });

  it("Token 不出现在 RoomSnapshot 中", async () => {
    const { manager } = makeManager();
    const creator = await manager.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: makeConfig(),
    });
    expect(JSON.stringify(creator.roomSnapshot)).not.toContain("token");
  });

  it("创建房间持久化 Room + Host 且邀请码唯一（两次创建互不相同）", async () => {
    const { manager, roomRepository } = makeManager();
    const a = await manager.createRoom({ displayName: "A", displayNameKey: "a", config: makeConfig() });
    const b = await manager.createRoom({ displayName: "B", displayNameKey: "b", config: makeConfig() });
    expect(a.roomSnapshot.inviteCode).not.toBe(b.roomSnapshot.inviteCode);
    expect(roomRepository.createdRooms).toHaveLength(2);
    expect(roomRepository.createdRooms[0]?.inviteCode).toBe(a.roomSnapshot.inviteCode);
    expect(roomRepository.createdRooms[0]?.mode).toBe("MULTIPLAYER");
    // 创建即持久化为 LOBBY，与内存权威状态一致（不残留 CREATED）
    expect(roomRepository.createdRooms[0]?.initialStatus).toBe("LOBBY");
  });

  it("Host Grace 转让会立即广播新的权威 hostPlayerId", async () => {
    const { manager } = makeManager();
    const host = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config: makeConfig() });
    const joined = await manager.joinRoom({ inviteCode: host.roomSnapshot.inviteCode!, displayName: "Alice", displayNameKey: "alice" });
    const snapshots: string[] = [];
    const unsubscribe = manager.subscribe((snapshot) => snapshots.push(snapshot.hostPlayerId ?? ""));

    await manager.transferHost(host.roomId);

    unsubscribe();
    expect(snapshots).toEqual([joined.playerId]);
  });
});

  it("持久化降级（soft/hard watermark / 关停）时 START_TOURNAMENT 被拒绝，其他命令不受门控", async () => {
    let available = true;
    const manager = createRoomManager({
      persistence: fakePersistence(),
      roomRepository: fakeRoomRepository(),
      ids: fakeIds(),
      tokenSecret: TOKEN_SECRET,
      tokenKeyId: TOKEN_KEY_ID,
      isPersistenceAvailable: () => available,
    });
    const host = await manager.createRoom({ displayName: "Host", displayNameKey: "host", config: makeConfig() });
    available = false; // 降级
    await expect(
      manager.submitCommand(host.roomId, {
        type: "START_TOURNAMENT",
        actorPlayerId: host.playerId,
        expectedRevision: 1,
        tournamentId: "t-x",
      }),
    ).rejects.toMatchObject({ code: "GAME_UNAVAILABLE" });
    // 非开局命令不被门控（加入成员仍可用）。
    const joined = await manager.joinRoom({
      inviteCode: host.roomSnapshot.inviteCode!,
      displayName: "Alice",
      displayNameKey: "alice",
    });
    expect(joined.playerId).toBeDefined();
  });
