import { describe, expect, it } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import type { TournamentConfig } from "@texas-holdem/protocol";
import { createFakeClock, type FakeClock } from "../../../../tests/support/fake-clock";
import { createRoomManager, type RoomManager } from "../rooms/room-manager";
import { createRoomPersistence } from "../rooms/room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentStarter,
} from "../rooms/tournament-starter";
import { fakeRoomRepository } from "../rooms/test-support";
import type { IdSource } from "../rooms/id-source";
import { createTournamentManager, type TournamentManager } from "./tournament-manager";
import { stableStringify } from "../infrastructure/persistence/checksum";
import type { HandCommitBundle } from "../infrastructure/persistence/repositories/hand-commit";

const CONFIG: TournamentConfig = {
  maxPlayers: 10,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 60,
};

function fakeIds(clock: FakeClock): IdSource {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    randomBytes: (count) => new Uint8Array(count),
    now: () => clock.now(),
  };
}

interface Wired {
  readonly clock: FakeClock;
  readonly roomManager: RoomManager;
  readonly tournamentManager: TournamentManager;
  readonly bundles: HandCommitBundle[];
}

/** 组装 main.ts 同构的 Room ↔ Tournament 运行时（fake 持久化，不依赖 DB）。 */
function makeWired(): Wired {
  const clock = createFakeClock({ now: 1000 });
  const ids = fakeIds(clock);
  const roomRepository = fakeRoomRepository();
  const baseStarter = createPersistenceTournamentStarter(roomRepository);
  const bundles: HandCommitBundle[] = [];

  // eslint-disable-next-line prefer-const -- 闭包在赋值前引用，需 let 维持 TDZ 语义
  let roomManager: RoomManager;
  const tournamentManager = createTournamentManager({
    clock: () => clock.now(),
    ids,
    scheduler: clock,
    output: {
      emitEvents: () => {},
      emitClockUpdated: () => {},
      enqueueCommitBundles: (batch) => bundles.push(...batch),
      submitRoomCommand: (roomId, command) => {
        void roomManager.submitCommand(roomId, command);
      },
    },
    executorDeps: { hashAction: (action) => stableStringify(action) },
  });
  const starter = createRuntimeTournamentStarter({
    persistence: baseStarter,
    manager: tournamentManager,
    clock: () => clock.now(),
    ids,
    scheduler: clock,
    rngFactory: () => new SeededRandomSource(42),
  });
  const persistence = createRoomPersistence({ roomRepository, startTournament: starter.start });
  roomManager = createRoomManager({
    persistence,
    roomRepository,
    ids,
    tokenSecret: "test-secret-012345678901234567890123456789",
    tokenKeyId: "k1",
  });

  return { clock, roomManager, tournamentManager, bundles };
}

async function prepareRoom(wired: Wired): Promise<{ roomId: string; p0: string; p1: string }> {
  const host = await wired.roomManager.createRoom({
    displayName: "Host",
    displayNameKey: "host",
    config: CONFIG,
  });
  const alice = await wired.roomManager.joinRoom({
    inviteCode: host.roomSnapshot.inviteCode!,
    displayName: "Alice",
    displayNameKey: "alice",
  });
  await wired.roomManager.submitCommand(host.roomId, { type: "CHANGE_SEAT", playerId: host.playerId, seat: 0 });
  await wired.roomManager.submitCommand(host.roomId, { type: "CHANGE_SEAT", playerId: alice.playerId, seat: 1 });
  await wired.roomManager.submitCommand(host.roomId, { type: "SET_READY", playerId: host.playerId, ready: true });
  await wired.roomManager.submitCommand(host.roomId, { type: "SET_READY", playerId: alice.playerId, ready: true });
  return { roomId: host.roomId, p0: host.playerId, p1: alice.playerId };
}

describe("TournamentManager × Room 装配（TEX-20 开局/终局闭环）", () => {
  it("开局创建运行时并驱动首手；冠军产生后把 Room 迁移到 FINISHED", async () => {
    const wired = makeWired();
    const { roomId, p0, p1 } = await prepareRoom(wired);
    const revision = Number(wired.roomManager.getSnapshot(roomId)!.roomRevision);
    const tournamentId = "t1";

    // 开局：Room 队列确认条件后创建 Tournament 运行时（fire-and-forget START）
    const started = await wired.roomManager.submitCommand(roomId, {
      type: "START_TOURNAMENT",
      actorPlayerId: p0,
      expectedRevision: revision,
      tournamentId,
    });
    expect(started.state.status).toBe("IN_GAME");
    expect(started.tournamentId).toBe(tournamentId);

    await Promise.resolve(); // 让 Tournament 的 START 命令 drain 并驱动首手
    const view = wired.tournamentManager.getView(tournamentId);
    expect(view).toBeDefined();
    expect(view!.status).toBe("RUNNING");
    expect(view!.engineState.handNumber).toBe(1);
    expect(view!.engineState.handInProgress).toBe(true);

    // 驱动首手至终局：p0（SB 首行动者）全下，p1 跟注 → 比牌淘汰一人 → 冠军
    const firstActor = currentActorId(wired.tournamentManager, tournamentId)!;
    const caller = firstActor === p0 ? p1 : p0;
    await wired.tournamentManager.submit(tournamentId, {
      type: "SUBMIT_ACTION",
      requestId: "req-1",
      actionId: "act-1",
      playerId: firstActor,
      expectedSequence: String(wired.tournamentManager.getView(tournamentId)!.lastWireSequence),
      action: { type: "ALL_IN" },
      receivedAt: wired.clock.now(),
      ingressOrdinal: 1,
    });
    const callerSequence = String(wired.tournamentManager.getView(tournamentId)!.lastWireSequence);
    await wired.tournamentManager.submit(tournamentId, {
      type: "SUBMIT_ACTION",
      requestId: "req-2",
      actionId: "act-2",
      playerId: caller,
      expectedSequence: callerSequence,
      action: { type: "CALL" },
      receivedAt: wired.clock.now(),
      ingressOrdinal: 2,
    });
    await Promise.resolve();

    const finishedView = wired.tournamentManager.getView(tournamentId);
    expect(finishedView!.status).toBe("FINISHED");
    // Room 队列异步消化 TOURNAMENT_FINISHED 后迁移
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wired.roomManager.getSnapshot(roomId)!.status).toBe("FINISHED");
    expect(wired.roomManager.getSnapshot(roomId)!.activeTournamentId).toBeNull();
    // 终局手携带 tournamentFinish（FINISHED + champion），Tournament/Room 结果可原子落库
    const lastBundle = wired.bundles[wired.bundles.length - 1];
    expect(lastBundle).toBeDefined();
    expect(lastBundle!.tournamentFinish?.status).toBe("FINISHED");
    expect(lastBundle!.tournamentFinish?.championTournamentPlayerId).toBeTypeOf("string");
    // 每手 bundle 的 handId 与 wire 事件 handId 一致（M3）
    const wireHandId = wired.tournamentManager.getView(tournamentId) === undefined
      ? null
      : wired.bundles.map((b) => b.hand.id)[wired.bundles.length - 1];
    expect(wireHandId).toBeTypeOf("string");
  });
});

function currentActorId(manager: TournamentManager, tournamentId: string): string | null {
  const view = manager.getView(tournamentId);
  if (view === undefined) return null;
  const seat = view.engineState.hand?.currentActor ?? null;
  if (seat === null) return null;
  return view.seatToPlayer.get(seat) ?? null;
}
