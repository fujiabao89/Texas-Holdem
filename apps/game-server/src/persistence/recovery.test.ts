import { describe, it, expect } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import { createFakeClock, type FakeClock } from "../../../../tests/support/fake-clock";
import {
  createFakeRecoveryRepository,
  makeActiveTournament,
  makeBundle,
  snapshotRecordFromBundle,
} from "../../tests/fixtures/persistence";
import type { IdSource } from "../rooms/id-source";
import type { RecoveryRepository } from "../infrastructure/persistence/repositories/recovery";
import type {
  TournamentCreateInput,
  TournamentManager,
  TournamentRecoverFreshInput,
  TournamentRecoverInput,
} from "../tournaments/tournament-manager";
import { createTournamentManager } from "../tournaments/tournament-manager";
import { createTournamentRuntimeState, type PlayerSeed } from "../tournaments/tournament-runtime";
import { TournamentExecutor, type TournamentOutputSink } from "../tournaments/tournament-executor";
import type { ClockUpdatedPayload, GameEventMessage, TournamentConfig } from "@texas-holdem/protocol";
import type { HandCommitBundle } from "../infrastructure/persistence/repositories/hand-commit";
import { sha256Checksum } from "../infrastructure/persistence/checksum";
import { recoverActiveTournaments, type RecoveryDeps } from "./recovery";

/** 记录型 Fake TournamentManager：捕获 create/createRecovered 输入。 */
function fakeManager(): {
  manager: TournamentManager;
  created: TournamentCreateInput[];
  recovered: TournamentRecoverInput[];
  recoveredFresh: TournamentRecoverFreshInput[];
} {
  const created: TournamentCreateInput[] = [];
  const recovered: TournamentRecoverInput[] = [];
  const recoveredFresh: TournamentRecoverFreshInput[] = [];
  const manager: TournamentManager = {
    create(input) {
      created.push(input);
    },
    createRecovered(input) {
      recovered.push(input);
    },
    createRecoveredFresh(input) {
      recoveredFresh.push(input);
    },
    async submit() {
      return null;
    },
    getView() {
      return undefined;
    },
    async setConnection() {
      return undefined;
    },
    async pauseAll() {
      return undefined;
    },
    activeTournamentIds() {
      return [];
    },
  };
  return { manager, created, recovered, recoveredFresh };
}

function fakeIds(clock: FakeClock): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    randomBytes: (count) => new Uint8Array(count),
    now: () => clock.now(),
  };
}

function recoveryDeps(
  over: Partial<RecoveryDeps> & { recoveryRepo: RecoveryRepository; manager: TournamentManager },
): RecoveryDeps {
  const clock = createFakeClock({ now: 0 });
  return {
    recoveryRepo: over.recoveryRepo,
    manager: over.manager,
    clock: over.clock ?? (() => clock.now()),
    ids: over.ids ?? fakeIds(clock),
    scheduler: over.scheduler ?? clock,
    rngFactory: over.rngFactory ?? (() => new SeededRandomSource(42)),
    engineOptionsFactory: over.engineOptionsFactory,
    onUnrecoverable: over.onUnrecoverable,
  };
}

describe("recoverActiveTournaments（崩溃恢复编排）", () => {
  it("正常恢复：从最新手末 Snapshot 重建，wire 序列从快照水位延续", async () => {
    const { manager, recovered, created } = fakeManager();
    const repo = createFakeRecoveryRepository();
    const lastBundle = makeBundle("t1", 2, 7n, 4); // 水位 10
    repo.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo.setSnapshots([snapshotRecordFromBundle(lastBundle)]);
    repo.eventCount = 10n;

    const summary = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo, manager }));

    expect(summary.recovered).toEqual([{ tournamentId: "t1", fromSequence: 10n }]);
    expect(created).toHaveLength(0);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.recovered.lastWireSequence).toBe(10);
    expect(recovered[0]!.recovered.engineEventBase).toBe(10);
    expect(recovered[0]!.recovered.committedThroughHand).toBe(2);
  });

  it("首手尚未完整提交（水位 0）：从配置与锁定参赛者以恢复感知方式重新初始化", async () => {
    const { manager, recovered, recoveredFresh, created } = fakeManager();
    const repo = createFakeRecoveryRepository();
    repo.setActive([makeActiveTournament("t1", "r1", 0n)]);
    repo.setSnapshots([]);

    const summary = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo, manager }));

    expect(summary.reinitialized).toEqual([{ tournamentId: "t1" }]);
    expect(recovered).toHaveLength(0);
    expect(created).toHaveLength(0); // 不走普通 create（恢复感知路径）
    expect(recoveredFresh).toHaveLength(1);
    expect(recoveredFresh[0]!.tournamentId).toBe("t1");
    expect(recoveredFresh[0]!.players.map((p) => p.playerId)).toEqual(["t1-p0", "t1-p1", "t1-p2"]);
  });

  it("最新快照 checksum 损坏：向前退回上一个可验证快照并执行恢复回退", async () => {
    const { manager, recovered } = fakeManager();
    const repo = createFakeRecoveryRepository();
    const previous = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const corrupt = {
      ...snapshotRecordFromBundle(makeBundle("t1", 3, 11n, 4)),
      stateChecksum: Buffer.from("deadbeef".repeat(4), "hex"), // 篡改 → 损坏检测失败
    };
    repo.setActive([makeActiveTournament("t1", "r1", 14n)]);
    repo.setSnapshots([corrupt, previous]);
    repo.eventCount = 14n;

    const summary = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo, manager }));

    expect(summary.recovered).toEqual([{ tournamentId: "t1", fromSequence: 10n }]);
    expect(repo.rollbacks).toEqual([{ tournamentId: "t1", toSequence: 10n }]);
    expect(recovered[0]!.recovered.lastWireSequence).toBe(10);
  });

  it("孤立快照 / 事件缺口 / 版本不兼容均被拒绝：回退或隔离", async () => {
    // 事件缺口：水位对应快照存在但事件不连续 → 拒绝 → 回退上一个可验证快照。
    const { manager, recovered: rec1 } = fakeManager();
    const repo = createFakeRecoveryRepository();
    const latest = snapshotRecordFromBundle(makeBundle("t1", 3, 11n, 4)); // 序列 11..14
    const previous = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4)); // 序列 7..10
    repo.setActive([makeActiveTournament("t1", "r1", 14n)]);
    repo.setSnapshots([latest, previous]);
    repo.eventCount = 12n; // 事件只到 12，缺口 13..14 → 最新快照不可验证
    const s1 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo, manager }));
    expect(s1.recovered).toEqual([{ tournamentId: "t1", fromSequence: 10n }]);
    expect(repo.rollbacks).toEqual([{ tournamentId: "t1", toSequence: 10n }]);
    expect(rec1).toHaveLength(1);

    // 版本不兼容：schemaVersion 未知 → 全部快照拒绝 → 隔离。
    const { manager: m2, recovered: rec2 } = fakeManager();
    const repo2 = createFakeRecoveryRepository();
    const v1 = {
      ...snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4)),
      schemaVersion: 99, // 未知 Schema 版本 → 拒绝
    };
    repo2.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo2.setSnapshots([v1]);
    repo2.eventCount = 10n;
    const s2 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo2, manager: m2 }));
    expect(s2.unrecovered).toHaveLength(1);
    expect(s2.unrecovered[0]!.reason).toContain("no verifiable snapshot");
    expect(rec2).toHaveLength(0);

    // 孤立快照：快照序列超过水位 → 无候选 → 隔离。
    const { manager: m3, recovered: rec3 } = fakeManager();
    const repo3 = createFakeRecoveryRepository();
    const orphan = snapshotRecordFromBundle(makeBundle("t1", 5, 21n, 4));
    repo3.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo3.setSnapshots([orphan]);
    repo3.eventCount = 24n;
    const s3 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo3, manager: m3 }));
    expect(s3.unrecovered).toHaveLength(1);
    expect(rec3).toHaveLength(0);
  });

  it("无可验证恢复根：隔离该 Tournament 并上报 onUnrecoverable", async () => {
    const { manager } = fakeManager();
    const repo = createFakeRecoveryRepository();
    const reasons: string[] = [];
    repo.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo.setSnapshots([]); // 水位 > 0 但无快照
    const summary = await recoverActiveTournaments(
      recoveryDeps({
        recoveryRepo: repo,
        manager,
        onUnrecoverable: (_id, reason) => reasons.push(reason),
      }),
    );
    expect(summary.unrecovered).toHaveLength(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("no committed snapshot");
  });

  it("旧格式快照（缺 serverTimeBank）在 Time Bank 启用时被拒绝，不回退满余额（P1-C）", async () => {
    // 版本 1 旧格式（修复前生成、同 SCHEMA_VERSION=1 时代）：启用 Time Bank 但无 companion → 隔离。
    const { manager: m1, recovered: rec1 } = fakeManager();
    const repo1 = createFakeRecoveryRepository();
    const fresh1 = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const noCompanion1 = { ...(fresh1.state as Record<string, unknown>) };
    delete noCompanion1.serverTimeBank;
    const v1Old = {
      ...fresh1,
      schemaVersion: 1,
      state: noCompanion1,
      stateChecksum: sha256Checksum(noCompanion1),
    };
    repo1.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo1.setSnapshots([v1Old]);
    repo1.eventCount = 10n;
    const s1 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo1, manager: m1 }));
    expect(s1.unrecovered).toHaveLength(1); // 隔离，不把已消耗 Time Bank 重置为满
    expect(rec1).toHaveLength(0);

    // 版本 2 但缺 serverTimeBank（checksum 与无 companion 的 state 一致）→ 防御性拒绝。
    const { manager: m2, recovered: rec2 } = fakeManager();
    const repo2 = createFakeRecoveryRepository();
    const fresh2 = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const noCompanion2 = { ...(fresh2.state as Record<string, unknown>) };
    delete noCompanion2.serverTimeBank;
    const v2Missing = {
      ...fresh2,
      schemaVersion: 2,
      state: noCompanion2,
      stateChecksum: sha256Checksum(noCompanion2),
    };
    repo2.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo2.setSnapshots([v2Missing]);
    repo2.eventCount = 10n;
    const s2 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo2, manager: m2 }));
    expect(s2.unrecovered).toHaveLength(1);
    expect(rec2).toHaveLength(0);

    // 未启用 Time Bank（timeBank=0）的 v2 快照即使无 companion 也可恢复（检查是定向的）。
    const { manager: m3, recovered: rec3 } = fakeManager();
    const repo3 = createFakeRecoveryRepository();
    const fresh3 = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const state3 = { ...(fresh3.state as Record<string, unknown>) } as Record<string, unknown>;
    state3.config = { ...(state3.config as Record<string, unknown>), timeBank: 0 };
    delete state3.serverTimeBank;
    repo3.setActive([makeActiveTournament("t1", "r1", 10n)]);
    repo3.setSnapshots([
      { ...fresh3, schemaVersion: 2, state: state3, stateChecksum: sha256Checksum(state3) },
    ]);
    repo3.eventCount = 10n;
    const s3 = await recoverActiveTournaments(recoveryDeps({ recoveryRepo: repo3, manager: m3 }));
    expect(s3.recovered).toHaveLength(1);
    expect(rec3).toHaveLength(1);
  });
});

// ---- 端到端：真实执行器跑 2 手 → 崩溃恢复 → 下一手序列无缝衔接 ----

interface Sink extends TournamentOutputSink {
  readonly bundles: HandCommitBundle[];
  readonly events: GameEventMessage[];
  readonly clockUpdates: ClockUpdatedPayload[];
}

function makeSink(): Sink {
  const bundles: HandCommitBundle[] = [];
  const events: GameEventMessage[] = [];
  const clockUpdates: ClockUpdatedPayload[] = [];
  return {
    bundles,
    events,
    clockUpdates,
    emitEvents(messages) {
      events.push(...messages);
    },
    emitClockUpdated(payload) {
      clockUpdates.push(payload);
    },
    enqueueCommitBundles(batch) {
      bundles.push(...batch);
    },
    submitRoomCommand() {},
  };
}

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

function makePlayers(): PlayerSeed[] {
  return [0, 1, 2].map((seatIndex) => ({
    playerId: `p${seatIndex}`,
    tournamentPlayerId: `tp${seatIndex}`,
    displayName: `P${seatIndex}`,
    seatIndex,
    kind: "HUMAN" as const,
    startingStack: 1000,
  }));
}

/** 通过执行器打完整一手（全员 FOLD），以 handNumber 变化为手边界（避免自动推进到下一手）。 */
async function playHandThroughExecutor(executor: TournamentExecutor, clock: FakeClock): Promise<void> {
  const startHand = executor.getView().engineState.handNumber;
  let guard = 0;
  while (guard++ < 100) {
    const state = executor.getEngineState();
    const hand = state.hand;
    if (state.handNumber !== startHand) break; // 本手已结束并推进到下一手
    if (hand === null || hand.currentActor === null) break;
    const playerId = executor.getView().seatToPlayer.get(hand.currentActor)!;
    const result = await executor.submit({
      type: "SUBMIT_ACTION",
      requestId: `req-${guard}`,
      actionId: `act-${guard}`,
      playerId,
      expectedSequence: String(executor.getView().lastWireSequence),
      action: { type: "FOLD" },
      receivedAt: clock.now(),
      ingressOrdinal: guard,
    });
    if (result === null) break;
  }
}

/** 通过恢复后的 manager 打完整一手（全员 FOLD），以 handNumber 变化为手边界。 */
async function playHandThroughManager(
  manager: ReturnType<typeof createTournamentManager>,
  clock: FakeClock,
): Promise<void> {
  const startHand = manager.getView("t1")!.engineState.handNumber;
  let guard = 0;
  while (guard++ < 100) {
    const view = manager.getView("t1");
    if (view === undefined) break;
    if (view.engineState.handNumber !== startHand) break;
    const hand = view.engineState.hand;
    if (hand === null || hand.currentActor === null) break;
    const playerId = view.seatToPlayer.get(hand.currentActor)!;
    await manager.submit("t1", {
      type: "SUBMIT_ACTION",
      requestId: `r-${guard}`,
      actionId: `a-${guard}`,
      playerId,
      expectedSequence: String(view.lastWireSequence),
      action: { type: "FOLD" },
      receivedAt: clock.now(),
      ingressOrdinal: guard,
    });
  }
}

async function untilIdle(maxYields = 20): Promise<void> {
  for (let i = 0; i < maxYields; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe("崩溃恢复 Time Bank 保留（P1-B）", () => {
  it("消耗 Time Bank → 完成并提交一手 → 恢复后余额不增加", async () => {
    const clock = createFakeClock({ now: 1000 });
    const ids = fakeIds(clock);
    const sink = makeSink();

    // Phase 1：真实执行器，当前行动者使用 Time Bank（60→30）后完成手 1。
    const players = makePlayers();
    const runtime = createTournamentRuntimeState(
      { tournamentId: "t1", roomId: "r1", config: makeConfig(), players, rng: new SeededRandomSource(1) },
      { clock: () => clock.now(), ids, scheduler: clock },
    );
    const executor = new TournamentExecutor(runtime, { output: sink });
    await executor.submit({ type: "START" });
    const state = executor.getEngineState();
    const actorSeat = state.hand?.currentActor;
    expect(actorSeat).not.toBeNull();
    const actorPlayerId = executor.getView().seatToPlayer.get(actorSeat!)!;
    const before = executor.getView().timeBankRemainingMs.get(actorPlayerId)!;
    expect(before).toBe(60_000); // 满余额
    const tbResult = (await executor.submit({
      type: "USE_TIME_BANK",
      requestId: "tb-1",
      playerId: actorPlayerId,
      expectedSequence: String(executor.getView().lastWireSequence),
      receivedAt: clock.now(),
    })) as { status: string };
    expect(tbResult.status).toBe("APPLIED");
    expect(executor.getView().timeBankRemainingMs.get(actorPlayerId)).toBe(30_000); // 消耗 30s

    await playHandThroughExecutor(executor, clock); // 完成手 1 → bundle 提交
    expect(sink.bundles).toHaveLength(1);
    const bundle = sink.bundles[0]!;
    const parsedState = JSON.parse(String(bundle.snapshot.state)) as {
      serverTimeBank?: Record<string, number>;
    };
    // 快照已持久化剩余余额（P1-B）。
    expect(parsedState.serverTimeBank?.[actorPlayerId]).toBe(30);

    // Phase 2：从 bundle 恢复。
    const repo = createFakeRecoveryRepository();
    repo.setActive([
      makeActiveTournament("t1", "r1", bundle.snapshot.sequence, {
        players: players.map((p) => ({
          id: p.tournamentPlayerId,
          playerId: p.playerId,
          displayName: p.displayName,
          seatIndex: p.seatIndex,
          kind: p.kind,
          startingStack: BigInt(p.startingStack),
        })),
      }),
    ]);
    repo.setSnapshots([snapshotRecordFromBundle(bundle)]);
    repo.eventCount = bundle.snapshot.sequence;

    const manager = createTournamentManager({
      clock: () => clock.now(),
      ids,
      scheduler: clock,
      output: sink,
      executorDeps: {},
    });
    const summary = await recoverActiveTournaments({
      recoveryRepo: repo,
      manager,
      clock: () => clock.now(),
      ids,
      scheduler: clock,
      rngFactory: () => new SeededRandomSource(1),
    });
    expect(summary.recovered).toHaveLength(1);

    // Phase 3：恢复后余额为 30s，不重置为满。
    await untilIdle();
    const recoveredRemaining = manager.getView("t1")!.timeBankRemainingMs.get(actorPlayerId)!;
    expect(recoveredRemaining).toBe(30_000);
  });
});

describe("崩溃恢复端到端序列连续性", () => {
  it("恢复到最近手末后，下一手 bundle 首序列 = 快照水位 + 1，且不重放已提交事件", async () => {
    const clock = createFakeClock({ now: 1000 });
    const ids = fakeIds(clock);
    const sink = makeSink();

    // 崩溃前进程：真实运行时跑 2 手，产出 2 个 bundle（模拟已提交）。
    const players = makePlayers();
    const runtime = createTournamentRuntimeState(
      { tournamentId: "t1", roomId: "r1", config: makeConfig(), players, rng: new SeededRandomSource(1) },
      { clock: () => clock.now(), ids, scheduler: clock },
    );
    const executor = new TournamentExecutor(runtime, { output: sink });
    await executor.submit({ type: "START" });
    await playHandThroughExecutor(executor, clock);
    await playHandThroughExecutor(executor, clock);
    expect(sink.bundles).toHaveLength(2);
    const lastBundle = sink.bundles[1]!;
    const watermark = Number(lastBundle.snapshot.sequence);
    expect(watermark).toBeGreaterThan(0);

    // 新进程：全新 manager + 恢复仓储（活动比赛 + 快照）。
    const repo = createFakeRecoveryRepository();
    repo.setActive([
      makeActiveTournament("t1", "r1", BigInt(watermark), {
        players: players.map((p) => ({
          id: p.tournamentPlayerId,
          playerId: p.playerId,
          displayName: p.displayName,
          seatIndex: p.seatIndex,
          kind: p.kind,
          startingStack: BigInt(p.startingStack),
        })),
      }),
    ]);
    repo.setSnapshots([snapshotRecordFromBundle(lastBundle)]);
    repo.eventCount = BigInt(watermark);

    const manager = createTournamentManager({
      clock: () => clock.now(),
      ids,
      scheduler: clock,
      output: sink,
      executorDeps: {},
    });
    const summary = await recoverActiveTournaments({
      recoveryRepo: repo,
      manager,
      clock: () => clock.now(),
      ids,
      scheduler: clock,
      rngFactory: () => new SeededRandomSource(1),
    });
    expect(summary.recovered).toHaveLength(1);

    // 恢复运行时已被 START 驱动；推进并打第 3 手。
    expect(manager.getView("t1")).toBeDefined();
    await untilIdle();
    // 恢复后所有连接视为断开（docs/04 §13）：HUMAN 玩家 connected=false，且已启动宽限计时。
    for (const player of players) {
      const record = manager.getView("t1")!.players.get(player.playerId);
      expect(record!.connected).toBe(false);
      expect(record!.graceHandle).not.toBeNull(); // 10 分钟断线宽限已调度
    }
    await playHandThroughManager(manager, clock);

    const recoveredBundles = sink.bundles.slice(2);
    expect(recoveredBundles).toHaveLength(1);
    const next = recoveredBundles[0]!;
    // 首序列 = 水位 + 1；末序列 = 首序列 + 事件数 - 1。
    expect(next.events[0]!.sequence).toBe(BigInt(watermark + 1));
    expect(next.snapshot.sequence).toBe(BigInt(watermark + next.events.length));
    // 不重放已提交事件：全部新序列 > 水位。
    for (const event of next.events) {
      expect(event.sequence).toBeGreaterThan(BigInt(watermark));
    }
  });
});
