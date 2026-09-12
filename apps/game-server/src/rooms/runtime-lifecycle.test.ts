/**
 * TEX-52 bounded lifecycle soak: production Room/Tournament/Writer/epoch owners,
 * deterministic clock and shuffle, no PostgreSQL/network and no forced GC.
 * Reclamation is proved by owner/timer counts; heap/RSS are diagnostic samples.
 */
import { describe, expect, it } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import type { CommandResultPayload, TournamentConfig } from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { createSeededRandom, deriveSeed } from "../../../../tests/support/random";
import { createPersistenceWriter } from "../persistence/persistence-writer";
import { createConnectionEpochRegistry } from "../realtime/connection-epochs";
import {
  createTournamentManager,
  TOURNAMENT_RETENTION_MS,
} from "../tournaments/tournament-manager";
import {
  createRoomManager,
  CLOSED_ROOM_RETENTION_MS,
  type RoomManager,
  type PlayerSession,
} from "./room-manager";
import { createRoomPersistence } from "./room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentRegistrar,
} from "./tournament-starter";
import { fakeRoomRepository } from "./test-support";

const SEED = 5201;
const CONFIG: TournamentConfig = {
  maxPlayers: 2,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 0,
};

function lifecycle() {
  const clock = createFakeClock({ now: 1_750_000_000_000 });
  const random = createSeededRandom(SEED);
  let serial = 0;
  const ids = {
    uuid: () => `soak-${++serial}`,
    now: () => clock.now(),
    randomBytes: (count: number) =>
      Uint8Array.from({ length: count }, () => random.nextInt(0, 255)),
  };
  const epochs = createConnectionEpochRegistry();
  const repository = { ...fakeRoomRepository(), async createRoomWithHost() {} };
  let committed = 0;
  let emitted = 0;
  let unloaded = 0;
  let sequence = 0;
  let tournamentNumber = 0;
  const pendingRoomCommands = new Set<Promise<unknown>>();
  const roomErrors: unknown[] = [];
  const unloadWaiters = new Set<{ target: number; resolve: () => void }>();
  const heldCommits = new Map<string, () => void>();
  const blocked = new Set<string>();
  const writer = createPersistenceWriter({
    clock: () => clock.now(),
    scheduler: clock,
    random: () => 0.5,
    commit: {
      async commitHandBundle(bundle) {
        if (blocked.has(bundle.tournamentId)) {
          await new Promise<void>((resolve) => heldCommits.set(bundle.tournamentId, resolve));
        }
        committed += 1;
        return "committed";
      },
    },
  });
  // eslint-disable-next-line prefer-const -- same startup closure wiring as main.ts
  let rooms: RoomManager;
  const tournaments = createTournamentManager({
    clock: () => clock.now(),
    ids,
    scheduler: clock,
    output: {
      emitEvents: (events) => {
        emitted += events.length;
      },
      emitClockUpdated: () => undefined,
      enqueueCommitBundles: (bundles) => writer.enqueue(bundles),
      submitRoomCommand: (roomId, command) => {
        const pending = rooms.submitCommand(roomId, command);
        pendingRoomCommands.add(pending);
        void pending.then(
          () => pendingRoomCommands.delete(pending),
          (error) => {
            pendingRoomCommands.delete(pending);
            roomErrors.push(error);
          },
        );
      },
    },
    executorDeps: { isConnectionCurrent: epochs.isCurrent },
    onUnloaded: (tournamentId) => {
      writer.releaseTournament(tournamentId);
      unloaded += 1;
      for (const waiter of unloadWaiters) {
        if (unloaded >= waiter.target) {
          unloadWaiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
  });
  const starter = createPersistenceTournamentStarter(repository);
  const registrar = createRuntimeTournamentRegistrar({
    manager: tournaments,
    rngFactory: () => new SeededRandomSource(deriveSeed(SEED, `tournament-${tournamentNumber++}`)),
  });
  rooms = createRoomManager({
    ids,
    roomRepository: repository,
    persistence: createRoomPersistence({
      roomRepository: repository,
      startTournament: starter.start,
    }),
    tokenSecret: "tex52-lifecycle-test-token-secret-0000000001",
    tokenKeyId: "test-key",
    clock: () => clock.now(),
    scheduler: clock,
    isConnectionCurrent: epochs.isCurrent,
    onStartCommitted: registrar.register,
    onClosed: async (roomId) => {
      epochs.forgetRoom(roomId);
      await tournaments.disposeRoom(roomId);
    },
  });

  async function drainRoomCommands(): Promise<void> {
    while (pendingRoomCommands.size > 0) await Promise.all([...pendingRoomCommands]);
    expect(roomErrors).toEqual([]);
  }

  async function table(): Promise<{ host: PlayerSession; guest: PlayerSession }> {
    const host = await rooms.createRoom({
      displayName: "Host",
      displayNameKey: "host",
      config: CONFIG,
    });
    const guest = await rooms.joinRoom({
      inviteCode: host.roomSnapshot.inviteCode!,
      displayName: "Guest",
      displayNameKey: "guest",
    });
    for (const [seat, session] of [host, guest].entries()) {
      epochs.takeOver(session.roomId, session.playerId);
      await rooms.submitCommand(session.roomId, {
        type: "CHANGE_SEAT",
        playerId: session.playerId,
        seat,
      });
      await rooms.submitCommand(session.roomId, {
        type: "SET_READY",
        playerId: session.playerId,
        ready: true,
      });
    }
    return { host, guest };
  }

  async function start(host: PlayerSession): Promise<string> {
    const tournamentId = ids.uuid();
    await rooms.submitCommand(host.roomId, {
      type: "START_TOURNAMENT",
      actorPlayerId: host.playerId,
      tournamentId,
      expectedRevision: Number(rooms.getSnapshot(host.roomId)!.roomRevision),
    });
    // Queue after START: this is an observable completion barrier, not an arbitrary sleep.
    await tournaments.setConnection(tournamentId, host.playerId, true);
    return tournamentId;
  }

  async function finish(tournamentId: string): Promise<void> {
    // All-in/check-call play normally terminates within one hand; ties are played on.
    for (let actions = 0; actions < 100; actions += 1) {
      const view = tournaments.getView(tournamentId)!;
      if (view.status === "FINISHED") {
        await drainRoomCommands();
        expect(rooms.getSnapshot(view.roomId)?.status).toBe("FINISHED");
        return;
      }
      expect(view.status).toBe("RUNNING");
      const actor = view.seatToPlayer.get(view.engineState.hand!.currentActor!)!;
      const legal = view.currentLegalActions!;
      const result = (await tournaments.submit(tournamentId, {
        type: "SUBMIT_ACTION",
        playerId: actor,
        requestId: ids.uuid(),
        actionId: ids.uuid(),
        expectedSequence: String(view.lastWireSequence),
        action: legal.canAllIn
          ? { type: "ALL_IN" }
          : legal.canCall
            ? { type: "CALL" }
            : { type: "CHECK" },
        receivedAt: clock.now(),
        ingressOrdinal: ++sequence,
      })) as CommandResultPayload;
      expect(result.status).toBe("APPLIED");
    }
    throw new Error(`seed ${SEED}: tournament exceeded 100 actions`);
  }

  function waitForUnloaded(target: number): Promise<void> {
    if (unloaded >= target) return Promise.resolve();
    return new Promise((resolve) => unloadWaiters.add({ target, resolve }));
  }

  function counts() {
    return {
      rooms: rooms.runtimeCounts(),
      tournaments: tournaments.runtimeCounts(),
      queues: writer.queueCount(),
      pending: writer.pendingCount(),
      epochs: epochs.activeCount(),
      timers: clock.pendingTimers(),
    };
  }

  async function dispose(): Promise<void> {
    for (const release of heldCommits.values()) release();
    blocked.clear();
    await drainRoomCommands();
    await rooms.dispose();
    await tournaments.dispose();
    await writer.flush();
    writer.dispose();
    expect(clock.pendingTimers()).toBe(0);
    clock.dispose();
  }

  return {
    clock,
    rooms,
    tournaments,
    writer,
    epochs,
    table,
    start,
    finish,
    drainRoomCommands,
    counts,
    waitForUnloaded,
    dispose,
    blocked,
    committed: () => committed,
    emitted: () => emitted,
    releaseCommit(tournamentId: string) {
      blocked.delete(tournamentId);
      const release = heldCommits.get(tournamentId);
      expect(release).toBeDefined();
      heldCommits.delete(tournamentId);
      release!();
    },
  };
}

const EMPTY = {
  rooms: { registered: 0, active: 0, closedTombstones: 0 },
  tournaments: { registered: 0, running: 0, finishedRetained: 0, frozen: 0 },
  queues: 0,
  pending: 0,
  epochs: 0,
  timers: 0,
};

describe("TEX-52 deterministic runtime lifecycle soak", () => {
  it("returns every owner to baseline across 24 rooms and 72 normally completed rounds", async () => {
    const h = lifecycle();
    const memorySamples: {
      batch: number;
      heapUsed: number;
      rss: number;
      commits: number;
      counts: ReturnType<typeof h.counts>;
    }[] = [];
    try {
      expect(h.counts()).toEqual(EMPTY);
      for (let batch = 0; batch < 3; batch += 1) {
        const tables = await Promise.all(Array.from({ length: 8 }, () => h.table()));
        for (let round = 0; round < 3; round += 1) {
          const tournamentIds = await Promise.all(tables.map(({ host }) => h.start(host)));
          expect(h.tournaments.runtimeCounts().running).toBe(8);
          await Promise.all(tournamentIds.map((tournamentId) => h.finish(tournamentId)));
          await h.writer.flush();
          expect(h.tournaments.runtimeCounts()).toEqual({
            registered: (round + 1) * 8,
            running: 0,
            finishedRetained: (round + 1) * 8,
            frozen: 0,
          });
          expect(h.writer.pendingCount()).toBe(0);
        }
        expect(h.writer.queueCount()).toBe(24);
        expect(h.epochs.activeCount()).toBe(16);
        h.clock.advance(TOURNAMENT_RETENTION_MS - 1);
        expect(h.tournaments.runtimeCounts().finishedRetained).toBe(24);
        h.clock.advance(1);
        await h.waitForUnloaded((batch + 1) * 24);
        expect(h.tournaments.runtimeCounts().registered).toBe(0);
        expect(h.writer.queueCount()).toBe(0);
        await Promise.all(
          tables.map(({ host }) =>
            h.rooms.submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "SOAK_COMPLETE" }),
          ),
        );
        expect(h.rooms.runtimeCounts()).toEqual({ registered: 0, active: 0, closedTombstones: 8 });
        for (const { host } of tables) {
          expect(Object.keys(h.rooms.getTombstone(host.roomId)!).sort()).toEqual([
            "closedAt",
            "closedReason",
            "roomId",
          ]);
          expect(() => h.rooms.authenticate(host.roomId, host.playerToken)).toThrow(
            "ROOM_NOT_FOUND",
          );
        }
        expect(h.epochs.activeCount()).toBe(0);
        h.clock.advance(CLOSED_ROOM_RETENTION_MS);
        expect(h.counts()).toEqual(EMPTY);
        const { heapUsed, rss } = process.memoryUsage();
        memorySamples.push({
          batch: batch + 1,
          heapUsed,
          rss,
          commits: h.committed(),
          counts: h.counts(),
        });
      }
      expect(h.committed()).toBeGreaterThanOrEqual(72);
      // Numeric samples make run output reviewable; byte decrease is not a GC-independent proof.
      console.info(
        `[TEX-52 bounded soak] ${JSON.stringify({ seed: SEED, rooms: 24, tournaments: 72, memorySamples })}`,
      );
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it("keeps an uncommitted terminal bundle after Room unload, then frees its queue only after commit", async () => {
    const h = lifecycle();
    try {
      const { host } = await h.table();
      const tournamentId = await h.start(host);
      h.blocked.add(tournamentId);
      await h.finish(tournamentId);
      expect(h.writer.pendingCount()).toBeGreaterThan(0);
      const pending = h.writer.pendingCount();
      await h.rooms.submitCommand(host.roomId, {
        type: "CLOSE_ROOM",
        reason: "CLOSE_WITH_PENDING_COMMIT",
      });
      expect(h.rooms.runtimeCounts().registered).toBe(0);
      expect(h.tournaments.runtimeCounts().registered).toBe(0);
      expect(h.writer.pendingCount()).toBe(pending);
      expect(h.writer.queueCount()).toBe(1);
      expect(h.epochs.activeCount()).toBe(0);
      h.releaseCommit(tournamentId);
      await h.writer.flush();
      expect(h.committed()).toBeGreaterThan(0);
      expect(h.writer.pendingCount()).toBe(0);
      expect(h.writer.queueCount()).toBe(0);
      h.clock.advance(CLOSED_ROOM_RETENTION_MS);
      expect(h.counts()).toEqual(EMPTY);
    } finally {
      await h.dispose();
    }
  });

  it("cancels an active Room's action callbacks and rejects its stale commands after immediate unload", async () => {
    const h = lifecycle();
    try {
      const { host } = await h.table();
      const tournamentId = await h.start(host);
      expect(h.tournaments.runtimeCounts().running).toBe(1);
      expect(h.clock.pendingTimers()).toBeGreaterThan(0);
      const previousDeadline = h.tournaments.getView(tournamentId)!.actionDeadline!;
      await h.rooms.submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "CLOSE_ACTIVE" });
      const emittedAtClose = h.emitted();
      expect(h.tournaments.runtimeCounts().registered).toBe(0);
      expect(h.rooms.runtimeCounts().registered).toBe(0);
      expect(h.epochs.activeCount()).toBe(0);
      await expect(h.tournaments.setConnection(tournamentId, host.playerId, true)).rejects.toThrow(
        "TOURNAMENT_NOT_ACTIVE",
      );
      await expect(
        h.rooms.submitCommand(host.roomId, {
          type: "SET_READY",
          playerId: host.playerId,
          ready: true,
        }),
      ).rejects.toThrow("ROOM_NOT_FOUND");
      h.clock.advance(CLOSED_ROOM_RETENTION_MS + Math.max(0, previousDeadline - h.clock.now()));
      await h.drainRoomCommands();
      expect(h.emitted()).toBe(emittedAtClose);
      expect(h.counts()).toEqual(EMPTY);
    } finally {
      await h.dispose();
    }
  });
});
