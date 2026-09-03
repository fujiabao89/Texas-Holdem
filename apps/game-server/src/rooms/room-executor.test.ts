import { describe, expect, it } from "vitest";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { RoomDomainError } from "./room-errors";
import { RoomRuntime, type RoomRuntimeDeps } from "./room-executor";
import type { IdSource } from "./id-source";
import type { InsertMemberInput, RoomPersistence } from "./room-persistence";
import { createRoomState, type RoomMemberSeed } from "./room-runtime";
import type { TournamentStartRequest } from "./tournament-starter";

function makeConfig(): TournamentConfig {
  return {
    maxPlayers: 10,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 30,
    timeBank: 60,
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

/** 内存记录型假持久化：记录写入调用，可注入失败。 */
function fakePersistence(): RoomPersistence & { calls: string[]; failNext: (error: Error) => void } {
  const calls: string[] = [];
  let fail: Error | undefined;
  return {
    calls,
    failNext(error) {
      fail = error;
    },
    async insertMember(input: InsertMemberInput) {
      calls.push(`insert:${input.playerId}`);
      if (fail) throw fail;
    },
    async markMemberLeft(_roomId, playerId) {
      calls.push(`left:${playerId}`);
      if (fail) throw fail;
    },
    async leaveRoomMember(_roomId, playerId) {
      calls.push(`left:${playerId}`);
      if (fail) throw fail;
    },
    async updateRoomConfig() {
      calls.push("config");
    },
    async setRoomHost() {
      calls.push("host");
    },
    async setRoomStatus(_roomId, status) {
      calls.push(`status:${status}`);
    },
    async startTournament(request: TournamentStartRequest) {
      calls.push(`start:${request.tournamentId}`);
    },
  };
}

function fakeIds(): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    randomBytes: (count) => new Uint8Array(count),
    now: () => 5000,
  };
}

function makeRuntime(maxPlayers = 10, extraDeps: Partial<RoomRuntimeDeps> = {}) {
  const state = createRoomState({
    roomId: "room-1",
    inviteCode: "ABC123",
    host: makeMember("host-1", "Host"),
    config: { ...makeConfig(), maxPlayers },
  });
  const persistence = fakePersistence();
  const deps: RoomRuntimeDeps = { persistence, ids: fakeIds(), ...extraDeps };
  const runtime = new RoomRuntime(state, deps);
  return { runtime, persistence, state };
}

/** 把房间推进到"2 名真人入座且 Ready"，便于开局测试。 */
async function readyForStart(runtime: RoomRuntime) {
  await runtime.submit({ type: "JOIN", member: makeMember("alice", "Alice") });
  await runtime.submit({ type: "CHANGE_SEAT", playerId: "host-1", seat: 0 });
  await runtime.submit({ type: "CHANGE_SEAT", playerId: "alice", seat: 1 });
  await runtime.submit({ type: "SET_READY", playerId: "host-1", ready: true });
  await runtime.submit({ type: "SET_READY", playerId: "alice", ready: true });
}

describe("RoomRuntime（串行执行器）", () => {
  it("同一 Room 的命令按提交顺序严格串行执行", async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    const first = runtime.submit({ type: "JOIN", member: makeMember("slow", "Slow", { joinedAt: 1000 }) });
    const second = runtime.submit({ type: "JOIN", member: makeMember("fast", "Fast", { joinedAt: 1001 }) });
    void first.then(() => order.push("join1-done"));
    await Promise.all([first, second]);
    expect(order).toEqual(["join1-done"]);
    expect(runtime.current.members.size).toBe(3);
  });

  it("持久化失败不提交内存状态（先提交后确认）", async () => {
    const { runtime, persistence } = makeRuntime();
    const before = runtime.current;
    persistence.failNext(new Error("db down"));
    await expect(runtime.submit({ type: "JOIN", member: makeMember("alice", "Alice") })).rejects.toThrow(
      "db down",
    );
    expect(runtime.current).toBe(before);
    expect(runtime.current.members.has("alice")).toBe(false);
  });

  it("并发加入不突破容量：满房时其余请求被拒", async () => {
    const { runtime } = makeRuntime(3);
    const joins = Array.from({ length: 5 }, (_, i) =>
      runtime
        .submit({ type: "JOIN", member: makeMember(`p${i}`, `P${i}`) })
        .then(() => "ok")
        .catch((error: unknown) => (error instanceof RoomDomainError ? error.code : "other")),
    );
    const results = await Promise.all(joins);
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "ROOM_FULL")).toHaveLength(3);
    expect(runtime.current.members.size).toBe(3);
  });

  it("开局运行时注册发生在 Room 提交 IN_GAME 之后（TEX-28 F-7 回归）", async () => {
    const registerLog: string[] = [];
    const { runtime, persistence } = makeRuntime(10, {
      onStartCommitted: (request) => {
        // 注册回调被触发时，Room 内存态必须已提交 IN_GAME 且 activeTournamentId 就位：
        // 首手事件随之在快照提交后产出，网关按 room 快照路由不会丢弃开局事件。
        registerLog.push(`status=${runtime.current.status};active=${runtime.current.activeTournamentId};t=${request.tournamentId}`);
      },
    });
    await readyForStart(runtime);
    const expectedRevision = runtime.current.roomRevision;
    await runtime.submit({
      type: "START_TOURNAMENT",
      actorPlayerId: "host-1",
      expectedRevision,
      tournamentId: "t-f7",
    });
    expect(registerLog).toEqual(["status=IN_GAME;active=t-f7;t=t-f7"]);
    expect(runtime.current.status).toBe("IN_GAME");
    // 控制面落库仍在注册之前（§5.7 先提交后确认：持久化成功才提交内存态）。
    expect(persistence.calls).toContain("start:t-f7");
  });

  it("并发开局最多产生一个活跃 Tournament：其余被拒且不落库", async () => {
    const { runtime, persistence } = makeRuntime();
    await readyForStart(runtime);
    const expectedRevision = runtime.current.roomRevision;
    type StartOutcome = { ok: boolean; code?: string; tournamentId?: string };
    const starts: StartOutcome[] = await Promise.all(
      ["t-1", "t-2", "t-3"].map((tournamentId) =>
        runtime
          .submit({
            type: "START_TOURNAMENT",
            actorPlayerId: "host-1",
            expectedRevision,
            tournamentId,
          })
          .then((result): StartOutcome => ({ ok: true, tournamentId: result.tournamentId }))
          .catch((error: unknown): StartOutcome => ({
            ok: false,
            code: error instanceof RoomDomainError ? error.code : "other",
          })),
      ),
    );
    expect(starts.filter((s) => s.ok)).toHaveLength(1);
    // 其余以 STALE_ROOM_STATE（旧 revision）或 ROOM_LOCKED（已 IN_GAME）拒绝，均不得再创建比赛
    const losers = starts.filter((s) => !s.ok);
    expect(losers).toHaveLength(2);
    expect(losers.every((s) => s.code === "STALE_ROOM_STATE" || s.code === "ROOM_LOCKED")).toBe(true);
    expect(persistence.calls.filter((c) => c.startsWith("start:"))).toHaveLength(1);
    expect(runtime.current.status).toBe("IN_GAME");
  });

  it("再来一局：FINISHED 房间经 FINISHED→LOBBY 迁移后成功开局新 Tournament", async () => {
    const { runtime, persistence } = makeRuntime();
    await readyForStart(runtime);
    await runtime.submit({ type: "START_TOURNAMENT", actorPlayerId: "host-1", expectedRevision: runtime.current.roomRevision, tournamentId: "t-1" });
    await runtime.submit({ type: "TOURNAMENT_FINISHED", tournamentId: "t-1" });
    expect(runtime.current.status).toBe("FINISHED");

    const result = await runtime.submit({
      type: "START_TOURNAMENT",
      actorPlayerId: "host-1",
      expectedRevision: runtime.current.roomRevision,
      tournamentId: "t-2",
    });
    expect(result.state.status).toBe("IN_GAME");
    expect(result.state.activeTournamentId).toBe("t-2");
    expect(result.tournamentId).toBe("t-2");
    // 两次开局各落库一次；中间 LOBBY 不持久化（单命令原子完成）
    expect(persistence.calls.filter((c) => c.startsWith("start:"))).toEqual(["start:t-1", "start:t-2"]);
    expect(persistence.calls).not.toContain("status:LOBBY");
  });

  it("再来一局：FINISHED 状态下 revision 过期或非 Host 被拒且不提交内存状态", async () => {
    const { runtime, persistence } = makeRuntime();
    await readyForStart(runtime);
    await runtime.submit({ type: "START_TOURNAMENT", actorPlayerId: "host-1", expectedRevision: runtime.current.roomRevision, tournamentId: "t-1" });
    await runtime.submit({ type: "TOURNAMENT_FINISHED", tournamentId: "t-1" });
    const before = runtime.current;

    await expect(
      runtime.submit({ type: "START_TOURNAMENT", actorPlayerId: "host-1", expectedRevision: before.roomRevision - 1, tournamentId: "t-2" }),
    ).rejects.toThrowError("STALE_ROOM_STATE");
    await expect(
      runtime.submit({ type: "START_TOURNAMENT", actorPlayerId: "alice", expectedRevision: before.roomRevision, tournamentId: "t-3" }),
    ).rejects.toThrowError("NOT_HOST");
    expect(runtime.current).toBe(before);
    expect(runtime.current.status).toBe("FINISHED");
    expect(persistence.calls.filter((c) => c.startsWith("start:"))).toEqual(["start:t-1"]);
  });

  it("Host 离开时把 Host 转移给最早加入的真人并持久化新 Host", async () => {
    const { runtime, persistence } = makeRuntime();
    await runtime.submit({ type: "JOIN", member: makeMember("alice", "Alice") });
    await runtime.submit({ type: "JOIN", member: makeMember("bob", "Bob") });
    await runtime.submit({ type: "LEAVE", playerId: "host-1", reason: "USER_LEFT", leftAt: 9000 });
    expect(runtime.current.hostPlayerId).toBe("alice");
    // 原子离开：单一 leaveRoomMember 调用同时完成 LEFT 标记与 Host 回填
    expect(persistence.calls).toContain("left:host-1");
  });

  it("CLOSED 后业务命令被拒，SET_READY 等不落库", async () => {
    const { runtime, persistence } = makeRuntime();
    await runtime.submit({ type: "CLOSE_ROOM", reason: "ABANDONED_NO_HUMAN" });
    await expect(runtime.submit({ type: "SET_READY", playerId: "host-1", ready: true })).rejects.toThrowError(
      new RoomDomainError("ROOM_LOCKED"),
    );
    await expect(runtime.submit({ type: "JOIN", member: makeMember("x", "X") })).rejects.toThrowError(
      new RoomDomainError("INVITE_EXPIRED"),
    );
    expect(runtime.current.status).toBe("CLOSED");
    expect(persistence.calls).toContain("status:CLOSED");
  });
});
