import { describe, expect, it } from "vitest";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { RoomDomainError } from "./room-errors";
import {
  RoomMemberSeed,
  changeSeat,
  closeRoom,
  createRoomState,
  joinRoom,
  kickPlayer,
  leaveRoom,
  markTournamentFinished,
  projectRoomSnapshot,
  returnToLobby,
  setReady,
  startTournament,
  transferHost,
  updateConfig,
} from "./room-runtime";

function makeConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    maxPlayers: 4,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 30,
    timeBank: 60,
    ...overrides,
  };
}

function makeMember(
  playerId: string,
  displayName: string,
  overrides: Partial<RoomMemberSeed> = {},
): RoomMemberSeed {
  return {
    playerId,
    displayName,
    displayNameKey: displayName.normalize("NFKC").toLowerCase(),
    kind: "HUMAN",
    tokenDigest: Buffer.alloc(32, 1),
    tokenKeyId: "k1",
    joinedAt: 1000,
    ...overrides,
  };
}

function baseRoom() {
  const host = makeMember("host-1", "Host", { joinedAt: 1000 });
  const state = createRoomState({
    roomId: "room-1",
    inviteCode: "ABC123",
    host,
    config: makeConfig(),
  });
  return { host, state };
}

/** 构造 LOBBY 且全员入座 Ready 的房间（2 名真人），便于开局测试。 */
function readyRoom() {
  const { state } = baseRoom();
  const alice = makeMember("alice", "Alice", { joinedAt: 2000 });
  let s = joinRoom(state, alice);
  s = changeSeat(s, "host-1", 0);
  s = changeSeat(s, "alice", 1);
  s = setReady(s, "host-1", true);
  s = setReady(s, "alice", true);
  return { state: s, alice };
}

describe("createRoomState", () => {
  it("创建后进入 LOBBY、Host 为创建者、revision 为 1、成员仅创建者且未入座未 Ready", () => {
    const { state, host } = baseRoom();
    expect(state.status).toBe("LOBBY");
    expect(state.hostPlayerId).toBe("host-1");
    expect(state.roomRevision).toBe(1);
    expect(state.activeTournamentId).toBeNull();
    expect(state.members.size).toBe(1);
    const member = state.members.get("host-1");
    expect(member?.displayName).toBe(host.displayName);
    expect(member?.seat).toBeNull();
    expect(member?.ready).toBe(false);
    expect(member?.connectionStatus).toBe("CONNECTED");
    expect(member?.pokerStatus).toBe("ACTIVE");
  });
});

describe("joinRoom", () => {
  it("LOBBY 内加入成员，revision 递增，新成员未入座未 Ready", () => {
    const { state } = baseRoom();
    const next = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    expect(next.roomRevision).toBe(state.roomRevision + 1);
    expect(next.members.get("alice")?.seat).toBeNull();
    expect(next.members.get("alice")?.ready).toBe(false);
  });

  it("满房时拒绝 ROOM_FULL", () => {
    const { state } = baseRoom();
    let s = state;
    for (const id of ["a", "b", "c"]) {
      s = joinRoom(s, makeMember(id, id.toUpperCase(), { joinedAt: 2000 }));
    }
    expect(() => joinRoom(s, makeMember("d", "D", { joinedAt: 2000 }))).toThrowError(
      new RoomDomainError("ROOM_FULL"),
    );
  });

  it("同房间规范化昵称判重（Unicode case-fold）拒绝 NICKNAME_TAKEN", () => {
    const { state } = baseRoom();
    const next = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    // "ＡＬＩＣＥ" NFKC 归一后与 "alice"（NFKC+lower）同 key
    expect(() => joinRoom(next, makeMember("bob", "ＡＬＩＣＥ", { joinedAt: 3000 }))).toThrowError(
      new RoomDomainError("NICKNAME_TAKEN"),
    );
  });

  it("关闭房拒绝 INVITE_EXPIRED，比赛中拒绝 ROOM_LOCKED", () => {
    const { state } = baseRoom();
    const closed = closeRoom(state, "ABANDONED_NO_HUMAN");
    expect(() => joinRoom(closed, makeMember("x", "X", { joinedAt: 2000 }))).toThrowError(
      new RoomDomainError("INVITE_EXPIRED"),
    );
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(() => joinRoom(started, makeMember("x", "X", { joinedAt: 2000 }))).toThrowError(
      new RoomDomainError("ROOM_LOCKED"),
    );
  });
});

describe("changeSeat", () => {
  it("成员只能移动自己的座位（以 playerId 断言），revision 递增", () => {
    const { state } = baseRoom();
    const next = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    const moved = changeSeat(next, "alice", 2);
    expect(moved.members.get("alice")?.seat).toBe(2);
    expect(moved.roomRevision).toBe(next.roomRevision + 1);
  });

  it("座位被占用时拒绝 INVALID_ACTION；非法座位号拒绝 INVALID_ACTION", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = changeSeat(s, "host-1", 0);
    expect(() => changeSeat(s, "alice", 0)).toThrowError(new RoomDomainError("INVALID_ACTION"));
    expect(() => changeSeat(s, "alice", 4)).toThrowError(new RoomDomainError("INVALID_ACTION"));
    expect(() => changeSeat(s, "alice", -1)).toThrowError(new RoomDomainError("INVALID_ACTION"));
  });

  it("非成员拒绝 FORBIDDEN；换座重置该成员 Ready", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = changeSeat(s, "alice", 1);
    s = setReady(s, "alice", true);
    s = changeSeat(s, "alice", 2);
    expect(s.members.get("alice")?.ready).toBe(false);
    expect(() => changeSeat(s, "ghost", 0)).toThrowError(new RoomDomainError("FORBIDDEN"));
  });

  it("IN_GAME 时拒绝 ROOM_LOCKED", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(() => changeSeat(started, "host-1", 1)).toThrowError(new RoomDomainError("ROOM_LOCKED"));
  });
});

describe("setReady", () => {
  it("LOBBY 内可切换 Ready；IN_GAME 拒绝 ROOM_LOCKED；非成员拒绝 FORBIDDEN", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = setReady(s, "alice", true);
    expect(s.members.get("alice")?.ready).toBe(true);
    expect(() => setReady(s, "ghost", true)).toThrowError(new RoomDomainError("FORBIDDEN"));
    const { state: ready } = readyRoom();
    const started = startTournament(ready, {
      actorPlayerId: "host-1",
      expectedRevision: ready.roomRevision,
      tournamentId: "t-1",
    });
    expect(() => setReady(started, "alice", false)).toThrowError(new RoomDomainError("ROOM_LOCKED"));
  });
});

describe("updateConfig", () => {
  it("仅 Host 且仅 LOBBY 可改配置；改配置重置全员 Ready", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = setReady(s, "alice", true);
    s = setReady(s, "host-1", true);
    const newConfig = makeConfig({ startingStack: 2000 });
    const updated = updateConfig(s, "host-1", newConfig);
    expect(updated.config.startingStack).toBe(2000);
    expect([...updated.members.values()].every((m) => m.ready === false)).toBe(true);
    expect(() => updateConfig(s, "alice", newConfig)).toThrowError(new RoomDomainError("NOT_HOST"));
  });

  it("IN_GAME 时拒绝 ROOM_LOCKED；新配置容量小于现有成员数拒绝 INVALID_ACTION", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(() => updateConfig(started, "host-1", makeConfig())).toThrowError(
      new RoomDomainError("ROOM_LOCKED"),
    );
    const twoMember = changeSeat(s, "host-1", 0);
    const next = changeSeat(twoMember, "alice", 1);
    // 现有 2 名成员，新配置 maxPlayers=1 拒绝
    expect(() => updateConfig(next, "host-1", makeConfig({ maxPlayers: 1 }))).toThrowError(
      new RoomDomainError("INVALID_ACTION"),
    );
  });

  it("缩小 maxPlayers 时清掉越界座位并重置 Ready，避免残留 seat >= maxPlayers 写入开局快照", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = changeSeat(s, "host-1", 2);
    s = changeSeat(s, "alice", 3);
    s = setReady(s, "host-1", true);
    s = setReady(s, "alice", true);
    const shrunk = updateConfig(s, "host-1", makeConfig({ maxPlayers: 2 }));
    expect(shrunk.members.get("host-1")?.seat).toBeNull();
    expect(shrunk.members.get("alice")?.seat).toBeNull();
    expect([...shrunk.members.values()].every((m) => m.ready === false)).toBe(true);
  });
});

describe("kickPlayer", () => {
  it("仅 Host 可踢人，且仅 LOBBY；不能踢自己或不存在成员", () => {
    const { state } = baseRoom();
    const s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    const kicked = kickPlayer(s, "host-1", "alice");
    expect(kicked.members.has("alice")).toBe(false);
    expect(() => kickPlayer(s, "alice", "host-1")).toThrowError(new RoomDomainError("NOT_HOST"));
    expect(() => kickPlayer(s, "host-1", "host-1")).toThrowError(new RoomDomainError("INVALID_ACTION"));
    expect(() => kickPlayer(s, "host-1", "ghost")).toThrowError(new RoomDomainError("INVALID_ACTION"));
  });

  it("IN_GAME 时拒绝 ROOM_LOCKED", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(() => kickPlayer(started, "host-1", "alice")).toThrowError(
      new RoomDomainError("ROOM_LOCKED"),
    );
  });
});

describe("leaveRoom / transferHost", () => {
  it("Host 主动离开立即转移给最早加入的在线真人", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = joinRoom(s, makeMember("bob", "Bob", { joinedAt: 3000 }));
    const after = leaveRoom(s, "host-1", { reason: "USER_LEFT", leftAt: 4000 });
    expect(after.members.has("host-1")).toBe(false);
    expect(after.hostPlayerId).toBe("alice");
  });

  it("无其他真人时 Host 离开后 hostPlayerId 为 null", () => {
    const { state } = baseRoom();
    const after = leaveRoom(state, "host-1", { reason: "USER_LEFT", leftAt: 2000 });
    expect(after.hostPlayerId).toBeNull();
  });

  it("transferHost 是显式可注入入口：把 Host 转给最早加入且在线的真人；无在线真人时保持 null", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = joinRoom(s, makeMember("bob", "Bob", { joinedAt: 3000 }));
    const after = transferHost(s);
    expect(after.hostPlayerId).toBe("alice");
    const lonely = transferHost(state);
    expect(lonely.hostPlayerId).toBeNull();
  });

  it("非成员离开拒绝 FORBIDDEN", () => {
    const { state } = baseRoom();
    expect(() => leaveRoom(state, "ghost", { reason: "USER_LEFT", leftAt: 2000 })).toThrowError(
      new RoomDomainError("FORBIDDEN"),
    );
  });
});

describe("startTournament", () => {
  it("LOBBY、Host、2 名真人均入座且全部 Ready 时原子开局：IN_GAME + activeTournamentId + revision 递增", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(started.status).toBe("IN_GAME");
    expect(started.activeTournamentId).toBe("t-1");
    expect(started.roomRevision).toBe(s.roomRevision + 1);
  });

  it("expectedRoomRevision 不匹配拒绝 STALE_ROOM_STATE 并携带 currentRoomRevision", () => {
    const { state: s } = readyRoom();
    let caught: unknown;
    try {
      startTournament(s, { actorPlayerId: "host-1", expectedRevision: s.roomRevision + 5, tournamentId: "t-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RoomDomainError);
    const domain = caught as RoomDomainError;
    expect(domain.code).toBe("STALE_ROOM_STATE");
    expect(domain.details?.currentRoomRevision).toBe(String(s.roomRevision));
  });

  it("非 Host 拒绝 NOT_HOST", () => {
    const { state: s } = readyRoom();
    expect(() =>
      startTournament(s, { actorPlayerId: "alice", expectedRevision: s.roomRevision, tournamentId: "t-1" }),
    ).toThrowError(new RoomDomainError("NOT_HOST"));
  });

  it("未全部入座或未全部 Ready 时拒绝 INVALID_ACTION（Host 不能绕过自己的 Ready）", () => {
    const { state: s } = readyRoom();
    const notReady = setReady(s, "alice", false);
    expect(() =>
      startTournament(notReady, { actorPlayerId: "host-1", expectedRevision: notReady.roomRevision, tournamentId: "t-1" }),
    ).toThrowError(new RoomDomainError("INVALID_ACTION"));
    const hostNotReady = setReady(s, "host-1", false);
    expect(() =>
      startTournament(hostNotReady, { actorPlayerId: "host-1", expectedRevision: hostNotReady.roomRevision, tournamentId: "t-1" }),
    ).toThrowError(new RoomDomainError("INVALID_ACTION"));
    const standing = changeSeat(s, "alice", null);
    expect(() =>
      startTournament(standing, { actorPlayerId: "host-1", expectedRevision: standing.roomRevision, tournamentId: "t-1" }),
    ).toThrowError(new RoomDomainError("INVALID_ACTION"));
  });

  it("仅 1 名真人入座时不能开局", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("alice", "Alice", { joinedAt: 2000 }));
    s = changeSeat(s, "host-1", 0);
    s = setReady(s, "host-1", true);
    expect(() =>
      startTournament(s, { actorPlayerId: "host-1", expectedRevision: s.roomRevision, tournamentId: "t-1" }),
    ).toThrowError(new RoomDomainError("INVALID_ACTION"));
  });

  it("已开局（IN_GAME）拒绝 ROOM_LOCKED，不得创建第二场活跃 Tournament", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    expect(() =>
      startTournament(started, { actorPlayerId: "host-1", expectedRevision: started.roomRevision, tournamentId: "t-2" }),
    ).toThrowError(new RoomDomainError("ROOM_LOCKED"));
  });
});

describe("markTournamentFinished / returnToLobby / closeRoom", () => {
  it("比赛结束后 FINISHED，activeTournamentId 清空；returnToLobby 保留邀请码与配置回 LOBBY", () => {
    const { state: s } = readyRoom();
    const started = startTournament(s, {
      actorPlayerId: "host-1",
      expectedRevision: s.roomRevision,
      tournamentId: "t-1",
    });
    const finished = markTournamentFinished(started, "t-1");
    expect(finished.status).toBe("FINISHED");
    expect(finished.activeTournamentId).toBeNull();
    const lobby = returnToLobby(finished);
    expect(lobby.status).toBe("LOBBY");
    expect(lobby.inviteCode).toBe("ABC123");
    // IN_GAME 时，非活跃 tournamentId 的终局信号必须被拒（旧信号不能覆盖新比赛）
    expect(() => markTournamentFinished(started, "t-9")).toThrowError(
      new RoomDomainError("TOURNAMENT_NOT_ACTIVE"),
    );
  });

  it("closeRoom → CLOSED、inviteCode 置空、记录原因；CLOSED 后业务命令拒绝", () => {
    const { state } = baseRoom();
    const closed = closeRoom(state, "ABANDONED_NO_HUMAN");
    expect(closed.status).toBe("CLOSED");
    expect(closed.inviteCode).toBeNull();
    expect(closed.closedReason).toBe("ABANDONED_NO_HUMAN");
    expect(() => setReady(closed, "host-1", true)).toThrowError(new RoomDomainError("ROOM_LOCKED"));
    expect(() => changeSeat(closed, "host-1", 0)).toThrowError(new RoomDomainError("ROOM_LOCKED"));
  });
});

describe("projectRoomSnapshot", () => {
  it("revision 为十进制字符串；玩家按 seat 升序、未入座最后并按 playerId 稳定排序", () => {
    const { state } = baseRoom();
    let s = joinRoom(state, makeMember("bob", "Bob", { joinedAt: 2000 }));
    s = joinRoom(s, makeMember("alice", "Alice", { joinedAt: 3000 }));
    s = changeSeat(s, "bob", 2);
    const snapshot = projectRoomSnapshot(s);
    expect(snapshot.roomRevision).toBe(String(s.roomRevision));
    expect(snapshot.players.map((p) => p.playerId)).toEqual(["bob", "alice", "host-1"]);
  });

  it("CLOSED 时 inviteCode 为 null；Snapshot 不含任何 Token 字段", () => {
    const { state } = baseRoom();
    const closed = closeRoom(state, "ABANDONED_NO_HUMAN");
    const snapshot = projectRoomSnapshot(closed);
    expect(snapshot.inviteCode).toBeNull();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("tokenDigest");
    expect(serialized).not.toContain("tokenKeyId");
  });
});
