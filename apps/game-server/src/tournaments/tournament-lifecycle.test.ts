import { describe, expect, it, vi } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { createFakeCommitRepository } from "../../tests/fixtures/persistence";
import type { HandCommitBundle } from "../infrastructure/persistence/repositories/hand-commit";
import { createPersistenceWriter } from "../persistence/persistence-writer";
import type { TournamentOutputSink } from "./tournament-executor";
import {
  createTournamentManager,
  TOURNAMENT_RETENTION_MS,
  type TournamentManager,
  type TournamentManagerDeps,
} from "./tournament-manager";

const CONFIG: TournamentConfig = {
  maxPlayers: 10,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: "UNLIMITED",
  timeBank: 0,
};

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("lifecycle condition not reached");
}

function makeHarness(
  options: {
    retentionMs?: number;
    output?: Partial<TournamentOutputSink>;
    executorDeps?: TournamentManagerDeps["executorDeps"];
  } = {},
) {
  const clock = createFakeClock({ now: 1000 });
  const bundles: HandCommitBundle[] = [];
  const unloaded = vi.fn();
  let nextId = 0;
  const ids = {
    uuid: () => `id-${++nextId}`,
    now: clock.now,
    randomBytes: (size: number) => new Uint8Array(size),
  };
  const manager = createTournamentManager({
    clock: clock.now,
    scheduler: clock,
    ids,
    terminalRetentionMs: options.retentionMs,
    onUnloaded: unloaded,
    executorDeps: options.executorDeps ?? {},
    output: {
      emitEvents() {},
      emitClockUpdated() {},
      enqueueCommitBundles: (batch) => bundles.push(...batch),
      submitRoomCommand() {},
      ...options.output,
    },
  });
  const input = (tournamentId: string, roomId = "room") => ({
    tournamentId,
    roomId,
    config: CONFIG,
    rng: new SeededRandomSource(42),
    engineOptions: { firstDealerSeat: 0 },
    players: [0, 1].map((seatIndex) => ({
      playerId: `p${seatIndex}`,
      tournamentPlayerId: `${tournamentId}-p${seatIndex}`,
      displayName: `P${seatIndex}`,
      seatIndex,
      kind: "HUMAN" as const,
      startingStack: CONFIG.startingStack,
    })),
  });
  async function create(tournamentId: string, roomId?: string) {
    manager.create(input(tournamentId, roomId));
    await Promise.resolve();
  }
  return { manager, clock, bundles, unloaded, input, create };
}

async function finish(
  manager: TournamentManager,
  tournamentId: string,
  now: () => number,
): Promise<void> {
  for (let step = 0; step < 50; step++) {
    const view = manager.getView(tournamentId)!;
    if (view.status === "FINISHED") return;
    const playerId = view.seatToPlayer.get(view.engineState.hand!.currentActor!)!;
    const result = await manager.submit(tournamentId, {
      type: "SUBMIT_ACTION",
      playerId,
      requestId: `${tournamentId}-request-${step}`,
      actionId: `${tournamentId}-action-${step}`,
      expectedSequence: String(view.lastWireSequence),
      action: view.currentLegalActions?.canAllIn ? { type: "ALL_IN" } : { type: "CALL" },
      receivedAt: now(),
      ingressOrdinal: step,
    });
    expect(result).toMatchObject({ status: "APPLIED" });
  }
  throw new Error("tournament did not finish");
}

describe("TournamentManager lifecycle（TEX-52，§13.2）", () => {
  it("终局立即退出 active 计数，默认只读保留完整 10 分钟后卸载且只通知一次", async () => {
    const h = makeHarness();
    expect(h.manager.runtimeCounts()).toEqual({
      registered: 0,
      running: 0,
      finishedRetained: 0,
      frozen: 0,
    });
    await h.create("old");
    expect(h.manager.activeTournamentIds()).toEqual(["old"]);
    await finish(h.manager, "old", h.clock.now);
    expect(h.manager.runtimeCounts()).toEqual({
      registered: 1,
      running: 0,
      finishedRetained: 1,
      frozen: 0,
    });
    expect(h.manager.activeTournamentIds()).toEqual([]);
    expect(h.clock.pendingTimers()).toBe(1);
    h.clock.advance(TOURNAMENT_RETENTION_MS - 1);
    expect(h.manager.getView("old")?.status).toBe("FINISHED");
    h.clock.advance(1);
    await until(() => h.manager.getView("old") === undefined);
    expect(h.manager.runtimeCounts().registered).toBe(0);
    expect(h.unloaded).toHaveBeenCalledExactlyOnceWith("old");
    await h.manager.dispose();
    expect(h.unloaded).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers()).toBe(0);
    await expect(h.manager.submit("old", { type: "START" })).rejects.toMatchObject({
      code: "TOURNAMENT_NOT_ACTIVE",
    });
  });

  it("旧比赛到期或迟到 timer 不影响同房新比赛，也不删除重用 id 的新实例", async () => {
    const h = makeHarness({ retentionMs: 10 });
    const timers = vi.spyOn(h.clock, "setTimeout");
    await h.create("old");
    await finish(h.manager, "old", h.clock.now);
    const oldExpiry = timers.mock.calls.find(([, delay]) => delay === 10)![0];
    await h.create("new");
    const newState = h.manager.getView("new")!.engineState;
    expect(h.manager.runtimeCounts()).toEqual({
      registered: 2,
      running: 1,
      finishedRetained: 1,
      frozen: 0,
    });
    h.clock.advance(10);
    await until(() => h.manager.getView("old") === undefined);
    expect(h.manager.getView("new")!.engineState).toEqual(newState);
    await h.create("old");
    oldExpiry();
    await Promise.resolve();
    expect(h.manager.activeTournamentIds()).toEqual(["new", "old"]);
    expect(h.unloaded).toHaveBeenCalledTimes(1);
    await h.manager.dispose();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("CLOSED Room 同时清理本房终局与进行中比赛，其他房间保持运行", async () => {
    const h = makeHarness();
    await h.create("finished", "closed-room");
    await finish(h.manager, "finished", h.clock.now);
    await h.create("running", "closed-room");
    await h.manager.setConnection("running", "p0", false);
    await h.create("other", "open-room");
    await Promise.all([h.manager.disposeRoom("closed-room"), h.manager.disposeRoom("closed-room")]);
    expect(h.manager.getView("finished")).toBeUndefined();
    expect(h.manager.getView("running")).toBeUndefined();
    expect(h.manager.activeTournamentIds()).toEqual(["other"]);
    expect(h.manager.runtimeCounts()).toEqual({
      registered: 1,
      running: 1,
      finishedRetained: 0,
      frozen: 0,
    });
    expect(h.unloaded.mock.calls.map(([id]) => id).sort()).toEqual(["finished", "running"]);
    expect(h.clock.pendingTimers()).toBe(0);
    await h.manager.dispose();
  });

  it("同 id 重复注册被拒绝；shutdown 清理已排队 START，拒绝新比赛且不重复卸载", async () => {
    const h = makeHarness();
    h.manager.create(h.input("queued"));
    expect(() => h.manager.create(h.input("queued"))).toThrow();
    const disposal = h.manager.dispose();
    expect(h.manager.dispose()).toBe(disposal);
    await disposal;
    expect(h.bundles).toHaveLength(0);
    expect(h.manager.runtimeCounts().registered).toBe(0);
    expect(h.unloaded).toHaveBeenCalledExactlyOnceWith("queued");
    expect(h.clock.pendingTimers()).toBe(0);
    expect(() => h.manager.create(h.input("later"))).toThrow();
  });

  it("Engine 冻结独立计数并保留诊断，只有显式 Room/服务 dispose 才卸载", async () => {
    const h = makeHarness();
    const input = h.input("frozen");
    h.manager.create({
      ...input,
      rng: {
        nextInt: () => {
          throw new Error("test engine failure");
        },
      },
    });
    await Promise.resolve();
    expect(h.manager.runtimeCounts()).toEqual({
      registered: 1,
      running: 0,
      finishedRetained: 0,
      frozen: 1,
    });
    expect(h.manager.activeTournamentIds()).toEqual([]);
    await h.manager.pauseAll(false);
    h.clock.advance(TOURNAMENT_RETENTION_MS * 2);
    expect(h.manager.getView("frozen")?.status).toBe("FROZEN");
    await h.manager.disposeRoom("room");
    expect(h.unloaded).toHaveBeenCalledExactlyOnceWith("frozen");
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("恢复启动失败调用统一 dispose，不遗留 grace timer 或半注册 runtime", async () => {
    const h = makeHarness();
    const input = h.input("failed-recovery");
    await expect(
      h.manager.createRecoveredFresh({
        ...input,
        rng: {
          nextInt: () => {
            throw new Error("failed restart");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GAME_UNAVAILABLE" });
    expect(h.manager.runtimeCounts().registered).toBe(0);
    expect(h.clock.pendingTimers()).toBe(0);
    expect(h.unloaded).toHaveBeenCalledExactlyOnceWith("failed-recovery");
  });

  it("反复开赛/终局/卸载后 Manager 与 Writer 数量回落，积压重试可独立完成", async () => {
    const clock = createFakeClock();
    const commit = createFakeCommitRepository();
    const writer = createPersistenceWriter({
      clock: clock.now,
      scheduler: clock,
      commit,
      random: () => 0.5,
    });
    let nextId = 0;
    const manager = createTournamentManager({
      clock: clock.now,
      scheduler: clock,
      ids: {
        now: clock.now,
        uuid: () => `id-${++nextId}`,
        randomBytes: (size) => new Uint8Array(size),
      },
      executorDeps: {},
      terminalRetentionMs: 10,
      onUnloaded: writer.releaseTournament,
      output: {
        emitEvents() {},
        emitClockUpdated() {},
        enqueueCommitBundles: writer.enqueue,
        submitRoomCommand() {},
      },
    });
    const seed = makeHarness();
    for (let index = 0; index < 100; index++) {
      const id = `round-${index}`;
      commit.failTransient = 1;
      manager.create(seed.input(id));
      await Promise.resolve();
      await finish(manager, id, clock.now);
      clock.advance(10);
      await until(() => manager.runtimeCounts().registered === 0);
      expect(writer.pendingCount()).toBeGreaterThan(0);
      expect(writer.queueCount()).toBe(1);
      clock.advance(250);
      await until(() => writer.queueCount() === 0);
      expect(writer.pendingCount()).toBe(0);
      expect(clock.pendingTimers()).toBe(0);
    }
    expect(commit.committed).toHaveLength(100);
    await manager.dispose();
    await writer.flush();
    writer.dispose();
    expect(manager.runtimeCounts().registered).toBe(0);
    expect(writer.queueCount()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });
});
