import { describe, expect, it } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import type { ClockUpdatedPayload, GameEventMessage, SubmitAction, TournamentConfig } from "@texas-holdem/protocol";
import type { HandCommitBundle } from "../infrastructure/persistence/repositories/hand-commit";
import type { RoomCommand } from "../rooms/room-executor";
import type { IdSource } from "../rooms/id-source";
import { createFakeClock, type FakeClock } from "../../../../tests/support/fake-clock";
import { createTournamentRuntimeState, type PlayerSeed, type TournamentRuntimeState } from "./tournament-runtime";
import {
  TournamentExecutor,
  type TournamentOutputSink,
} from "./tournament-executor";
import type { TournamentCommand } from "./tournament-commands";

interface Harness {
  readonly executor: TournamentExecutor;
  readonly clock: FakeClock;
  readonly output: RecordingSink;
  readonly runtime: TournamentRuntimeState;
}

interface RecordingSink extends TournamentOutputSink {
  readonly events: GameEventMessage[];
  readonly clockUpdates: ClockUpdatedPayload[];
  readonly bundles: HandCommitBundle[];
  readonly roomCommands: RoomCommand[];
}

function makeConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    maxPlayers: 10,
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

function makePlayers(seatCount = 2): PlayerSeed[] {
  return Array.from({ length: seatCount }, (_, seatIndex) => ({
    playerId: `p${seatIndex}`,
    tournamentPlayerId: `tp${seatIndex}`,
    displayName: `P${seatIndex}`,
    seatIndex,
    kind: "HUMAN" as const,
    startingStack: 1000,
  }));
}

function fakeIds(clock: FakeClock): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    randomBytes: (count) => new Uint8Array(count),
    now: () => clock.now(),
  };
}

function recordingSink(): RecordingSink {
  const events: GameEventMessage[] = [];
  const clockUpdates: ClockUpdatedPayload[] = [];
  const bundles: HandCommitBundle[] = [];
  const roomCommands: RoomCommand[] = [];
  return {
    events,
    clockUpdates,
    bundles,
    roomCommands,
    emitEvents(messages) {
      events.push(...messages);
    },
    emitClockUpdated(payload) {
      clockUpdates.push(payload);
    },
    enqueueCommitBundles(batch) {
      bundles.push(...batch);
    },
    submitRoomCommand(_roomId, command) {
      roomCommands.push(command);
    },
  };
}

function makeHarness(overrides: {
  config?: Partial<TournamentConfig>;
  seats?: number;
  isConnectionCurrent?: (roomId: string, playerId: string, epoch: number) => boolean;
} = {}): Harness {
  const clock = createFakeClock({ now: 1000 });
  const config = makeConfig(overrides.config);
  const players = makePlayers(overrides.seats ?? 2);
  const output = recordingSink();
  const runtime = createTournamentRuntimeState(
    {
      tournamentId: "t1",
      roomId: "r1",
      config,
      players,
      rng: new SeededRandomSource(42),
      engineOptions: { firstDealerSeat: 0 },
    },
    { clock: () => clock.now(), ids: fakeIds(clock), scheduler: clock },
  );
  const executor = new TournamentExecutor(runtime, { output, isConnectionCurrent: overrides.isConnectionCurrent });
  return { executor, clock, output, runtime };
}

/** 当前行动者 playerId；无行动者为 null。 */
function currentActor(harness: Harness): string | null {
  const state = harness.executor.getEngineState();
  const seat = state.hand?.currentActor ?? null;
  if (seat === null) return null;
  return harness.executor.getView().seatToPlayer.get(seat) ?? null;
}

async function start(harness: Harness): Promise<void> {
  await harness.executor.submit({ type: "START" });
}

function submitAction(
  harness: Harness,
  opts: {
    playerId: string;
    action: SubmitAction;
    actionId?: string;
    expectedSequence?: string;
    receivedAt?: number;
  },
): Promise<unknown> {
  const sequence = opts.expectedSequence ?? String(harness.executor.getView().lastWireSequence);
  const receivedAt = opts.receivedAt ?? harness.clock.now();
  const command: TournamentCommand = {
    type: "SUBMIT_ACTION",
    requestId: `req-${Math.random()}`,
    actionId: opts.actionId ?? `act-${Math.random()}`,
    playerId: opts.playerId,
    expectedSequence: sequence,
    action: opts.action,
    receivedAt,
    ingressOrdinal: 0,
  };
  return harness.executor.submit(command);
}

const call = (): SubmitAction => ({ type: "CALL" });
const check = (): SubmitAction => ({ type: "CHECK" });
const fold = (): SubmitAction => ({ type: "FOLD" });

describe("TournamentExecutor（串行执行）", () => {
  it("同一 tournament 的命令按队列严格串行执行（并发相同动作只成功一次）", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    // 并发提交两个相同的 CALL：串行队列保证至多一个成功推进回合，另一个因 sequence 变化被拒。
    const results = await Promise.all([
      submitAction(harness, { playerId: firstActor, action: call(), actionId: "a1" }),
      submitAction(harness, { playerId: firstActor, action: call(), actionId: "a2" }),
    ]);
    const statuses = results.map((r) => (r as { status: string }).status);
    expect(statuses.filter((s) => s === "APPLIED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "REJECTED")).toHaveLength(1);
  });

  it("RECORD_ELAPSED_TIME 并发提交全部按序生效（time 模式；不丢命令）", async () => {
    const harness = makeHarness({ config: { blindMode: "time", blindStructure: [{ smallBlind: 5, bigBlind: 10, durationSeconds: 60 }] } });
    await start(harness);
    await Promise.all(
      Array.from({ length: 5 }, () => harness.executor.submit({ type: "RECORD_ELAPSED_TIME", seconds: 100 })),
    );
    expect(harness.executor.getEngineState().elapsedSeconds).toBe(500);
  });

  it("receivedAt 截止前合法 Action 胜过同时 Timer（look-ahead）", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const deadline = harness.clock.now() + 30_000;
    harness.clock.advance(30_000); // Timer 触发并入队（尚未执行）
    const before = harness.output.events.length;
    const result = (await submitAction(harness, {
      playerId: firstActor,
      action: call(),
      receivedAt: deadline,
    })) as { status: string };
    expect(result.status).toBe("APPLIED");
    // Timer 因状态已推进成为 stale no-op：无 SYSTEM_TIMER 自动折叠
    const newEvents = harness.output.events.slice(before);
    expect(newEvents.find((m) => m.payload.event.type === "PLAYER_FOLDED")).toBeUndefined();
  });

  it("receivedAt > 截止线且仍指向同一行动机会 → ACTION_TIMEOUT，不执行", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const result = (await submitAction(harness, {
      playerId: firstActor,
      action: call(),
      receivedAt: harness.clock.now() + 30_001,
    })) as { status: string; error?: { code: string } };
    expect(result.status).toBe("REJECTED");
    expect(result.error?.code).toBe("ACTION_TIMEOUT");
    expect(harness.output.events.filter((m) => m.payload.event.type === "PLAYER_CALLED")).toHaveLength(0);
  });

  it("Timer 到期执行 Auto Fold（SYSTEM_TIMER 源）", async () => {
    const harness = makeHarness();
    await start(harness);
    // firstDealerSeat=0 → p0 为 SB，首行动者面对 BB 无过牌权 → 超时折叠
    harness.clock.advance(30_000);
    await Promise.resolve();
    const folded = harness.output.events.find(
      (m): m is GameEventMessage & { payload: { event: { type: "PLAYER_FOLDED"; payload: { source: string; playerId: string } } } } =>
        m.payload.event.type === "PLAYER_FOLDED",
    );
    expect(folded).toBeDefined();
    expect(folded!.payload.event.payload.source).toBe("SYSTEM_TIMER");
    // 首行动者（座位 0）被系统折叠 → 该手结束并推进下一手
    expect(folded!.payload.event.payload.playerId).toBe("p0");
    expect(harness.executor.getEngineState().handNumber).toBeGreaterThanOrEqual(1);
  });
});

describe("Time Bank", () => {
  function useTimeBank(harness: Harness, playerId: string, requestId: string): Promise<unknown> {
    const sequence = String(harness.executor.getView().lastWireSequence);
    return harness.executor.submit({
      type: "USE_TIME_BANK",
      requestId,
      playerId,
      expectedSequence: sequence,
      receivedAt: harness.clock.now(),
    });
  }

  it("成功使用延长截止线并扣减余额；CLOCK_UPDATED 不推进 sequence", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const beforeDeadline = harness.executor.getView().actionDeadline!;
    const beforeSequence = harness.executor.getView().lastWireSequence;
    const result = (await useTimeBank(harness, firstActor, "req-tb")) as { status: string };
    expect(result.status).toBe("APPLIED");
    const view = harness.executor.getView();
    expect(view.actionDeadline).toBe(beforeDeadline + 30_000);
    expect(view.timeBankRemainingMs.get(firstActor)).toBe(30_000);
    expect(harness.output.clockUpdates).toHaveLength(1);
    expect(view.lastWireSequence).toBe(beforeSequence); // sequence 不因 Time Bank 推进（02 §7.1）
  });

  it("同一行动机会最多成功一次 → TIME_BANK_NOT_AVAILABLE", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    await useTimeBank(harness, firstActor, "r1");
    const second = (await useTimeBank(harness, firstActor, "r2")) as { status: string; error?: { code: string } };
    expect(second.status).toBe("REJECTED");
    expect(second.error?.code).toBe("TIME_BANK_NOT_AVAILABLE");
  });

  it("UNLIMITED 模式禁用 Time Bank → TIME_BANK_DISABLED", async () => {
    const harness = makeHarness({ config: { actionTime: "UNLIMITED", timeBank: 0 } });
    await start(harness);
    const firstActor = currentActor(harness)!;
    const result = (await useTimeBank(harness, firstActor, "r1")) as { status: string; error?: { code: string } };
    expect(result.status).toBe("REJECTED");
    expect(result.error?.code).toBe("TIME_BANK_DISABLED");
  });

  it("决策点未变（他人撤回）时 Time Bank 不能二次使用（GP-P1b）", async () => {
    const harness = makeHarness({ seats: 3 });
    await start(harness);
    // 首位全下，次位跟注全下（不可折叠），第三位保持当前行动者
    const first = currentActor(harness)!;
    await submitAction(harness, { playerId: first, action: { type: "ALL_IN" } });
    const second = currentActor(harness)!;
    await submitAction(harness, { playerId: second, action: { type: "CALL" } });
    const actor = currentActor(harness)!;
    expect(actor).not.toBe(first);
    expect(actor).not.toBe(second);
    await useTimeBank(harness, actor, "tb-1");
    // 撤回 all-in 的非当前行动者 → 当前行动者/决策点不变 → 机会标记不复位
    await harness.executor.submit({ type: "WITHDRAW_PLAYER", playerId: second, reason: "USER_LEFT" });
    expect(currentActor(harness)).toBe(actor);
    const again = (await useTimeBank(harness, actor, "tb-2")) as { status: string; error?: { code: string } };
    expect(again.status).toBe("REJECTED");
    expect(again.error?.code).toBe("TIME_BANK_NOT_AVAILABLE");
  });

  it("同一座位换街后的新行动机会可再次使用 Time Bank（§8.4 机会复位）", async () => {
    const harness = makeHarness();
    await start(harness);
    // HU：SB（p0）先行动，BB（p1）收官 preflop；postflop BB（p1）首发
    const sb = currentActor(harness)!;
    const bb = sb === "p0" ? "p1" : "p0";
    await submitAction(harness, { playerId: sb, action: call() }); // SB 跟注
    // BB 在 preflop 收官行动机会用一次 Time Bank
    const preflopUse = (await useTimeBank(harness, bb, "r1")) as { status: string };
    expect(preflopUse.status).toBe("APPLIED");
    // BB 过牌结束 preflop → flop 首发仍是 BB
    await submitAction(harness, { playerId: bb, action: check() });
    expect(currentActor(harness)).toBe(bb);
    // 新街新机会 → 可再次使用
    const flopUse = (await useTimeBank(harness, bb, "r2")) as { status: string };
    expect(flopUse.status).toBe("APPLIED");
  });
});

describe("断线 / 离开 / 宽限 / 无真人关房", () => {
  it("断线启动 10 分钟宽限；重连取消；不复连到期 → WITHDRAWN", async () => {
    const harness = makeHarness({ config: { actionTime: "UNLIMITED", timeBank: 0 } });
    await start(harness);
    const firstActor = currentActor(harness)!;
    await harness.executor.submit({ type: "CONNECTION_CHANGED", playerId: firstActor, connected: false });
    await harness.executor.submit({ type: "CONNECTION_CHANGED", playerId: firstActor, connected: true });
    harness.clock.advance(10 * 60 * 1000);
    await Promise.resolve();
    expect(harness.executor.getEngineState().participants.find((p) => p.seatIndex === 0)!.status).toBe("ACTIVE");

    await harness.executor.submit({ type: "CONNECTION_CHANGED", playerId: firstActor, connected: false });
    harness.clock.advance(10 * 60 * 1000 + 1);
    await Promise.resolve();
    expect(harness.executor.getEngineState().participants.find((p) => p.seatIndex === 0)!.status).toBe("WITHDRAWN");
  });

  it("全员断线且宽限同时到期 → 无真人关房（ABANDONED_NO_HUMAN + Room CLOSED）", async () => {
    const harness = makeHarness({ config: { actionTime: "UNLIMITED", timeBank: 0 } });
    await start(harness);
    const firstActor = currentActor(harness)!;
    const other = firstActor === "p0" ? "p1" : "p0";
    // 首行动者先全下（不可折叠），使其宽限到期时仅转 EXIT_PENDING 而不被折叠成冠军；
    // 随后两名玩家都断线，宽限同时到期 → 两手均 EXIT_PENDING → 结算后 0 名 ACTIVE → 无真人关房。
    await submitAction(harness, { playerId: firstActor, action: { type: "ALL_IN" } });
    await harness.executor.submit({ type: "CONNECTION_CHANGED", playerId: firstActor, connected: false });
    await harness.executor.submit({ type: "CONNECTION_CHANGED", playerId: other, connected: false });
    harness.clock.advance(10 * 60 * 1000);
    await Promise.resolve();
    const view = harness.executor.getView();
    expect(view.status).toBe("ABANDONED_NO_HUMAN");
    expect(harness.output.roomCommands).toContainEqual({ type: "CLOSE_ROOM", reason: "ABANDONED_NO_HUMAN" });
    // 计时任务已全部取消
    expect(harness.clock.pendingTimers()).toBe(0);
  });

  it("主动离开（WITHDRAW_PLAYER）撤回当前行动者", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    await harness.executor.submit({ type: "WITHDRAW_PLAYER", playerId: firstActor, reason: "USER_LEFT" });
    await Promise.resolve();
    const seat = firstActor === "p0" ? 0 : 1;
    const participant = harness.executor.getEngineState().participants.find((p) => p.seatIndex === seat)!;
    expect(participant.status).toBe("WITHDRAWN");
  });
});

describe("重复 / 非法 / 过期命令不污染权威状态", () => {
  it("接管后拒绝旧 Socket 已排队的 Action 与 Time Bank（epoch 权威校验）", async () => {
    const harness = makeHarness({ isConnectionCurrent: () => false });
    await start(harness);
    const actor = currentActor(harness)!;
    const sequence = String(harness.executor.getView().lastWireSequence);

    const action = await harness.executor.submit({
      type: "SUBMIT_ACTION",
      requestId: "stale-action-request",
      actionId: "stale-action-id",
      playerId: actor,
      expectedSequence: sequence,
      action: call(),
      receivedAt: harness.clock.now(),
      ingressOrdinal: 1,
      connectionEpoch: 1,
    }) as { status: string; error?: { code: string } };
    const timeBank = await harness.executor.submit({
      type: "USE_TIME_BANK",
      requestId: "stale-time-bank-request",
      playerId: actor,
      expectedSequence: sequence,
      receivedAt: harness.clock.now(),
      connectionEpoch: 1,
    }) as { status: string; error?: { code: string } };

    expect(action).toMatchObject({ status: "REJECTED", error: { code: "SESSION_REPLACED" } });
    expect(timeBank).toMatchObject({ status: "REJECTED", error: { code: "SESSION_REPLACED" } });
    expect(harness.executor.getView().lastWireSequence).toBe(Number(sequence));
    expect(harness.output.clockUpdates).toHaveLength(0);
  });

  it("接管后拒绝旧 Socket 发起的退出撤回", async () => {
    const harness = makeHarness({ isConnectionCurrent: () => false });
    await start(harness);
    const actor = currentActor(harness)!;
    await expect(harness.executor.submit({
      type: "WITHDRAW_PLAYER",
      playerId: actor,
      reason: "USER_LEFT",
      connectionEpoch: 1,
    })).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    expect(harness.executor.getEngineState().participants.find((participant) => participant.seatIndex === 0)?.status).toBe("ACTIVE");
  });

  it("重复 actionId 相同 Payload → duplicate 复用原结果，不二次执行", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const sequence = String(harness.executor.getView().lastWireSequence);
    const first = (await submitAction(harness, { playerId: firstActor, action: call(), actionId: "act-same", expectedSequence: sequence })) as { status: string; duplicate: boolean };
    expect(first.status).toBe("APPLIED");
    // 重试复用完全相同 Payload（含 expectedSequence）→ duplicate 复用原结果
    const second = (await submitAction(harness, { playerId: firstActor, action: call(), actionId: "act-same", expectedSequence: sequence })) as { status: string; duplicate: boolean };
    expect(second.status).toBe("APPLIED");
    expect(second.duplicate).toBe(true);
  });

  it("相同 actionId 相同动作但不同 expectedSequence → IDEMPOTENCY_KEY_REUSE", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const sequence = String(harness.executor.getView().lastWireSequence);
    await submitAction(harness, { playerId: firstActor, action: call(), actionId: "act-seq", expectedSequence: sequence });
    const retry = (await submitAction(harness, { playerId: firstActor, action: call(), actionId: "act-seq", expectedSequence: "999" })) as { status: string; error?: { code: string } };
    expect(retry.status).toBe("REJECTED");
    expect(retry.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("相同 actionId 不同 Payload → IDEMPOTENCY_KEY_REUSE", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const sequence = String(harness.executor.getView().lastWireSequence);
    await submitAction(harness, { playerId: firstActor, action: call(), actionId: "act-x", expectedSequence: sequence });
    const second = (await submitAction(harness, { playerId: firstActor, action: fold(), actionId: "act-x", expectedSequence: sequence })) as { status: string; error?: { code: string } };
    expect(second.status).toBe("REJECTED");
    expect(second.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("过期 expectedSequence → STALE_GAME_STATE；非本人回合 → NOT_YOUR_TURN", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const other = firstActor === "p0" ? "p1" : "p0";
    const stale = (await submitAction(harness, { playerId: firstActor, action: call(), expectedSequence: "999" })) as { status: string; error?: { code: string } };
    expect(stale.error?.code).toBe("STALE_GAME_STATE");
    const notTurn = (await submitAction(harness, { playerId: other, action: fold() })) as { status: string; error?: { code: string } };
    expect(notTurn.error?.code).toBe("NOT_YOUR_TURN");
  });

  it("USE_TIME_BANK 同 requestId 重试复用原结果且只扣一次余额（02 §7.3）", async () => {
    const harness = makeHarness();
    await start(harness);
    const firstActor = currentActor(harness)!;
    const sequence = String(harness.executor.getView().lastWireSequence);
    const submit = (requestId: string) =>
      harness.executor.submit({
        type: "USE_TIME_BANK",
        requestId,
        playerId: firstActor,
        expectedSequence: sequence,
        receivedAt: harness.clock.now(),
      });
    const first = (await submit("tb-same")) as { status: string; duplicate: boolean };
    expect(first.status).toBe("APPLIED");
    const second = (await submit("tb-same")) as { status: string; duplicate: boolean };
    expect(second.status).toBe("APPLIED");
    expect(second.duplicate).toBe(true);
    // 余额只扣一次（60s → 30s），未因重试再次扣减
    expect(harness.executor.getView().timeBankRemainingMs.get(firstActor)).toBe(30_000);
  });
});

describe("Engine Critical Error 冻结（§7.4/§15）", () => {
  it("冻结后拒绝业务命令（GAME_UNAVAILABLE）且不再推进", async () => {
    const harness = makeHarness();
    await start(harness);
    // 模拟 Engine Critical Error 后执行器置 FROZEN 并保存诊断
    harness.runtime.status = "FROZEN";
    harness.runtime.criticalDiagnostic = "不变量违反: 座位 0 筹码非法";
    harness.clock.advance(30_000); // Timer 已取消 → 不应触发自动动作
    const result = (await submitAction(harness, { playerId: "p0", action: call() })) as {
      status: string;
      error?: { code: string };
    };
    expect(result.status).toBe("REJECTED");
    expect(result.error?.code).toBe("GAME_UNAVAILABLE");
    expect(harness.executor.getView().status).toBe("FROZEN");
    expect(harness.clock.pendingTimers()).toBe(0);
  });
});

describe("time 模式定时升盲", () => {
  it("盲注计时器到期上报 elapsed，下一手使用新等级", async () => {
    const harness = makeHarness({
      config: {
        actionTime: "UNLIMITED",
        timeBank: 0,
        blindMode: "time",
        blindStructure: [
          { smallBlind: 5, bigBlind: 10, durationSeconds: 60 },
          { smallBlind: 10, bigBlind: 20, durationSeconds: 60 },
        ],
      },
    });
    await start(harness);
    expect(harness.executor.getEngineState().bigBlind).toBe(10);
    // 推进两个等级时长：60s→elapsed60（仍 level 0，含边界），120s→elapsed120（level 1）
    harness.clock.advance(120_000);
    await Promise.resolve();
    expect(harness.executor.getEngineState().elapsedSeconds).toBe(120);
    // 打完当前手后下一手使用 level 1（更高盲注）
    await playHandToCompletion(harness);
    expect(harness.executor.getEngineState().bigBlind).toBe(20);
  });
});

describe("事件 sequence 与 Commit Bundle", () => {
  it("wire 事件 sequence 从 1 单调递增；bundle 与水印对齐", async () => {
    const harness = makeHarness();
    await start(harness);
    await playHandToCompletion(harness);
    const view = harness.executor.getView();
    expect(view.lastWireSequence).toBeGreaterThan(0);
    // 每个 Engine 事件对每个接收者各产生一条消息（共享同一 sequence）；唯一 sequence 从 1 连续。
    const sequences = [...new Set(harness.output.events.map((m) => Number(m.payload.sequence)))].sort((a, b) => a - b);
    expect(sequences[0]).toBe(1);
    expect(sequences).toHaveLength(view.lastWireSequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1] + 1);
    }
    expect(harness.output.bundles.length).toBeGreaterThanOrEqual(1);
    const bundle = harness.output.bundles[0]!;
    expect(bundle.events[0]!.sequence).toBe(1n);
    expect(bundle.snapshot.sequence).toBe(bundle.events[bundle.events.length - 1]!.sequence);
    for (let i = 1; i < bundle.events.length; i++) {
      expect(bundle.events[i]!.handSequence).toBe(bundle.events[i - 1]!.handSequence + 1);
      expect(bundle.events[i]!.sequence).toBe(bundle.events[i - 1]!.sequence + 1n);
    }
  });

  it("逐事件 patch：PLAYER_CHECKED 不携带后续 FLOP 的 board/phase（GP-P1a）", async () => {
    const harness = makeHarness();
    await start(harness);
    const sb = currentActor(harness)!; // p0（SB）
    await submitAction(harness, { playerId: sb, action: call() });
    const bb = currentActor(harness)!; // p1（BB）
    const before = harness.output.events.length;
    // BB check → 一次转移产生 PLAYER_CHECKED + BURN_CARD + FLOP_DEALT
    await submitAction(harness, { playerId: bb, action: check() });
    const newEvents = harness.output.events.slice(before);
    const checked = newEvents.find((m) => m.payload.event.type === "PLAYER_CHECKED");
    const flop = newEvents.find((m) => m.payload.event.type === "FLOP_DEALT");
    expect(checked).toBeDefined();
    expect(flop).toBeDefined();
    // PLAYER_CHECKED 的 patch 必须反映该事件后的状态：PREFLOP、空 board（FLOP 尚未发出）
    expect(checked!.payload.patch.handPhase).toBe("PREFLOP");
    expect(checked!.payload.patch.board).toEqual([]);
    // FLOP_DEALT 的 patch 反映 FLOP 阶段与 3 张公共牌
    expect(flop!.payload.patch.handPhase).toBe("FLOP");
    expect(flop!.payload.patch.board).toHaveLength(3);
  });

  it("同街动作：PLAYER_CALLED 的 patch 指向下一位行动者并给其 legalActions（P1 回归）", async () => {
    const harness = makeHarness();
    await start(harness);
    const sb = currentActor(harness)!; // p0（SB）
    const before = harness.output.events.length;
    // SB CALL → 同街推进到 BB（不换街、无后续发牌事件）
    await submitAction(harness, { playerId: sb, action: call() });
    const bb = currentActor(harness)!; // 下一位行动者
    expect(bb).not.toBe(sb);
    const newEvents = harness.output.events.slice(before);
    const calledMsg = newEvents.find(
      (m) => m.payload.event.type === "PLAYER_CALLED" && m.payload.patch.viewer?.playerId === bb,
    );
    expect(calledMsg).toBeDefined();
    // patch 的 currentActorPlayerId 指向下一位行动者，且其 legalActions 非空
    expect(calledMsg!.payload.patch.currentActorPlayerId).toBe(bb);
    expect(calledMsg!.payload.patch.viewer?.legalActions).not.toBeNull();
  });

  it("非当前玩家撤回：PLAYER_FOLDED patch 的 currentActorPlayerId 保持原行动者（P1 回归）", async () => {
    const harness = makeHarness({ seats: 3 });
    await start(harness);
    const actor = currentActor(harness)!; // UTG（座位 0）正在行动
    const withdrawTarget = ["p0", "p1", "p2"].find((p) => p !== actor)!; // 非当前、未全下玩家
    const before = harness.output.events.length;
    await harness.executor.submit({ type: "WITHDRAW_PLAYER", playerId: withdrawTarget, reason: "USER_LEFT" });
    // 权威状态：原行动者仍待行动（非当前玩家撤回不转移行动权）
    expect(currentActor(harness)).toBe(actor);
    const newEvents = harness.output.events.slice(before);
    const foldedMsg = newEvents.find(
      (m) => m.payload.event.type === "PLAYER_FOLDED" && m.payload.patch.viewer?.playerId === actor,
    );
    expect(foldedMsg).toBeDefined();
    // patch 的行动者与权威状态一致：原行动者继续行动并拿到 legalActions
    expect(foldedMsg!.payload.patch.currentActorPlayerId).toBe(actor);
    expect(foldedMsg!.payload.patch.viewer?.legalActions).not.toBeNull();
  });

  it("非授权 Payload 不含其他玩家底牌（字段级隔离）", async () => {
    const harness = makeHarness();
    await start(harness);
    const dealToOther = harness.output.events.find(
      (m) => m.payload.event.type === "DEAL_HOLE_CARD" && (m.payload.event.payload as { playerId: string }).playerId !== "p0",
    );
    if (dealToOther !== undefined) {
      const card = (dealToOther.payload.event.payload as { card?: unknown }).card;
      expect(card).toBeUndefined();
    }
  });
});

/** 通过最简合法动作推进一手直到产生手末 Commit Bundle（CHECK → CALL → FOLD）。 */
async function playHandToCompletion(harness: Harness): Promise<void> {
  let guard = 0;
  for (;;) {
    if (guard++ > 60) throw new Error("test hand did not settle");
    if (harness.output.bundles.length > 0) return; // 一手已结算并提交
    const state = harness.executor.getEngineState();
    if (state.phase === "finished") return;
    const actor = currentActor(harness);
    if (actor === null) return;
    const legal = harness.executor.getView().currentLegalActions;
    const action = legal !== null && legal.canCheck ? check() : legal !== null && legal.canCall ? call() : fold();
    const result = (await submitAction(harness, { playerId: actor, action })) as { status: string };
    if (result.status === "REJECTED") return; // 动作非法 → 停止推进（不应发生）
  }
}
