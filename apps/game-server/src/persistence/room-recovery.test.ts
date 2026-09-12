import { describe, expect, it, vi } from "vitest";
import { SeededRandomSource, type TournamentState } from "@texas-holdem/poker-engine";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import {
  createFakeRecoveryRepository,
  makeActiveTournament,
  makeBundle,
  snapshotRecordFromBundle,
} from "../../tests/fixtures/persistence";
import { sha256Checksum } from "../infrastructure/persistence/checksum";
import { computePlayerTokenDigest } from "../infrastructure/persistence/player-token";
import { PersistenceError } from "../infrastructure/persistence/repositories/errors";
import type {
  RoomRecoveryRecord,
  RoomRecoveryRepository,
  RoomRecoveryTournament,
} from "../infrastructure/persistence/repositories/room-recovery";
import { createRoomManager } from "../rooms/room-manager";
import { fakePersistence, fakeRoomRepository } from "../rooms/test-support";
import type {
  TournamentManager,
  TournamentRecoverFreshInput,
  TournamentRecoverInput,
} from "../tournaments/tournament-manager";
import { recoverRoomsOnStartup, type RoomRecoveryDeps } from "./room-recovery";

const TOKEN_SECRET = "tex51-room-recovery-test-secret";
const KEY_ID = "test-key";
const ORIGINAL_TOKEN = "original-token-held-only-by-test-client";
const REVISION_INITIAL = 2 ** 32;
const REVISION_CEILING = 2 ** 33 - 1;

function fixture(roomId = "r1", tournamentId = "t1", watermark = 0n): RoomRecoveryRecord {
  const active = makeActiveTournament(tournamentId, roomId, watermark);
  return {
    roomId,
    mode: "MULTIPLAYER",
    inviteCode: roomId === "r1" ? "ABCDEF" : "GHJKMN",
    status: "IN_GAME",
    configJson: active.configJson,
    hostPlayerId: active.players[0]!.playerId,
    tournamentCount: 1,
    members: active.players.map((player, index) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      displayNameKey: player.displayName.toLowerCase(),
      kind: "HUMAN",
      tokenDigest: computePlayerTokenDigest({
        roomId,
        playerId: player.playerId,
        token: ORIGINAL_TOKEN,
        keyId: KEY_ID,
        secret: TOKEN_SECRET,
      }),
      tokenKeyId: KEY_ID,
      joinedAt: new Date(1_000 + index),
    })),
    tournaments: [{ ...active, tournamentNo: 1, status: "IN_GAME" }],
  };
}

function lobby(record = fixture()): RoomRecoveryRecord {
  return { ...record, status: "LOBBY", tournamentCount: 0, tournaments: [] };
}

function harness(records: RoomRecoveryRecord[]) {
  const clock = createFakeClock({ now: 10_000 });
  const ids = {
    uuid: () => "unused-test-id",
    randomBytes: (count: number) => new Uint8Array(count),
    now: () => clock.now(),
  };
  const roomRepository = fakeRoomRepository();
  const persistence = fakePersistence();
  const roomManager = createRoomManager({
    roomRepository,
    persistence,
    ids,
    tokenSecret: TOKEN_SECRET,
    tokenKeyId: KEY_ID,
  });
  const recoveryRepo = createFakeRecoveryRepository();
  recoveryRepo.setActive(
    records.flatMap((record) =>
      record.tournaments
        .filter((t) => t.status === "IN_GAME")
        .map((t) => ({ ...t, roomId: record.roomId })),
    ),
  );
  const listRecoverableRooms = vi.fn(async () => records);
  const reserveRoomRevision = vi.fn(async (_roomId: string) => ({
    initial: REVISION_INITIAL,
    ceiling: REVISION_CEILING,
  }));
  const roomRecoveryRepo: RoomRecoveryRepository = { listRecoverableRooms, reserveRoomRevision };
  const order: string[] = [];
  const createRecovered = vi.fn(async (input: TournamentRecoverInput) => {
    expect(roomManager.findRoom(input.roomId)).toBeDefined();
    order.push(`start:${input.tournamentId}`);
  });
  const createRecoveredFresh = vi.fn(async (input: TournamentRecoverFreshInput) => {
    expect(roomManager.findRoom(input.roomId)).toBeDefined();
    order.push(`start:${input.tournamentId}`);
  });
  const manager: TournamentManager = {
    create: vi.fn(),
    createRecovered,
    createRecoveredFresh,
    submit: vi.fn(async () => undefined),
    getView: vi.fn(() => undefined),
    setConnection: vi.fn(async () => undefined),
    pauseAll: vi.fn(async () => undefined),
    activeTournamentIds: vi.fn(() => []),
    ...{
      runtimeCounts: vi.fn(() => ({ registered: 0, running: 0, finishedRetained: 0, frozen: 0 })),
      disposeRoom: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    },
  };
  const setRoomStatus = vi
    .spyOn(roomRepository, "setRoomStatus")
    .mockImplementation(async (roomId, status) => {
      order.push(`status:${roomId}:${status}`);
    });
  const onIsolated = vi.fn();
  const deps: RoomRecoveryDeps = {
    roomRecoveryRepo,
    roomRepository,
    roomManager,
    manager,
    recoveryRepo,
    clock: () => clock.now(),
    ids,
    scheduler: clock,
    rngFactory: () => new SeededRandomSource(51),
    tokenKeyId: KEY_ID,
    onIsolated,
  };
  return {
    deps,
    roomManager,
    recoveryRepo,
    listRecoverableRooms,
    reserveRoomRevision,
    createRecovered,
    createRecoveredFresh,
    setRoomStatus,
    onIsolated,
    order,
    persistence,
  };
}

describe("TEX-51 complete Room/identity/Tournament startup barrier", () => {
  it("restores original HMAC identities and stable host with safe lobby defaults and a fresh revision reservation", async () => {
    const record = lobby();
    const h = harness([record]);
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.restoredRooms).toEqual([record.roomId]);
    expect(h.roomManager.authenticate(record.roomId, ORIGINAL_TOKEN)).toBe(record.hostPlayerId);
    const restored = h.roomManager.getSnapshot(record.roomId)!;
    expect(restored).toMatchObject({
      hostPlayerId: record.hostPlayerId,
      status: "LOBBY",
      inviteCode: record.inviteCode,
      roomRevision: String(REVISION_INITIAL),
    });
    expect(
      restored.players.every(
        (player) =>
          player.seat === null && !player.ready && player.connectionStatus === "DISCONNECTED",
      ),
    ).toBe(true);
    expect(JSON.stringify(restored)).not.toContain("token");
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
    // A repository-owned Buffer cannot later mutate the restored authentication state.
    record.members[0]!.tokenDigest!.fill(0);
    expect(h.roomManager.authenticate(record.roomId, ORIGINAL_TOKEN)).toBe(record.hostPlayerId);
  });

  it.each([
    [
      "missing-active-human-host",
      (record: RoomRecoveryRecord) => ({ ...record, hostPlayerId: null }),
    ],
    ["invalid-room-config", (record: RoomRecoveryRecord) => ({ ...record, configJson: {} })],
    ["invalid-invite-mode", (record: RoomRecoveryRecord) => ({ ...record, inviteCode: null })],
    [
      "unavailable-member-credential",
      (record: RoomRecoveryRecord) => ({
        ...record,
        members: record.members.map((m) => ({ ...m, tokenKeyId: "old-key" })),
      }),
    ],
    [
      "invalid-member-identity",
      (record: RoomRecoveryRecord) => ({
        ...record,
        members: [...record.members, record.members[0]!],
      }),
    ],
  ])(
    "isolates %s before registration and still restores a healthy sibling",
    async (reason, corrupt) => {
      const invalid = corrupt(lobby());
      const healthy = lobby(fixture("r2", "t2"));
      const h = harness([invalid, healthy]);
      const result = await recoverRoomsOnStartup(h.deps);
      expect(result.isolated).toContainEqual({
        roomId: invalid.roomId,
        tournamentId: undefined,
        reason,
      });
      expect(result.restoredRooms).toEqual([healthy.roomId]);
      expect(h.roomManager.findRoom(invalid.roomId)).toBeUndefined();
      expect(h.reserveRoomRevision.mock.calls).toEqual([[healthy.roomId]]);
      expect(h.onIsolated.mock.calls[0]![0]).not.toHaveProperty("tokenDigest");
    },
  );

  it("does not resurrect a missing or closed Room from an active Tournament record", async () => {
    const h = harness([]);
    h.recoveryRepo.setActive([makeActiveTournament("orphan", "closed-room", 0n)]);
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toEqual([
      { roomId: "closed-room", tournamentId: "orphan", reason: "missing-or-closed-room" },
    ]);
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
    expect(h.roomManager.activeRoomCount()).toBe(0);
  });

  it("rejects an ACTIVE checkpoint participant absent from Room and never commits a fallback before membership validation", async () => {
    const original = fixture("r1", "t1", 14n);
    const record = { ...original, members: original.members.slice(0, 2) };
    const h = harness([record]);
    h.recoveryRepo.setSnapshots([snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4))]);
    h.recoveryRepo.eventCount = 14n;
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated[0]?.reason).toBe("active-checkpoint-player-left-room");
    expect(h.recoveryRepo.rollbacks).toEqual([]);
    expect(h.reserveRoomRevision).not.toHaveBeenCalled();
    expect(h.roomManager.findRoom(record.roomId)).toBeUndefined();
  });

  it("allows a persisted WITHDRAWN participant to remain absent without restoring its credential", async () => {
    const original = fixture("r1", "t1", 10n);
    const record = { ...original, members: original.members.slice(0, 2) };
    const h = harness([record]);
    const snapshot = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const state = snapshot.state as {
      participants: { seatIndex: number; status: string; chips: number }[];
      forfeitedChips: number;
    };
    state.participants[2]!.status = "WITHDRAWN";
    state.participants[2]!.chips = 0;
    state.forfeitedChips = 100;
    h.recoveryRepo.setSnapshots([{ ...snapshot, stateChecksum: sha256Checksum(state) }]);
    h.recoveryRepo.eventCount = 10n;
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toEqual([]);
    expect(h.roomManager.getSnapshot(record.roomId)?.players).toHaveLength(2);
    expect(h.createRecovered).toHaveBeenCalledOnce();
    expect(h.createRecovered.mock.calls[0]![0].players).toHaveLength(3);
  });

  it("rejects LOBBY with an active latest Tournament and Room/Tournament config disagreement", async () => {
    for (const record of [
      { ...fixture(), status: "LOBBY" as const },
      { ...fixture(), configJson: { ...(fixture().configJson as object), actionTime: 60 } },
    ]) {
      const h = harness([record]);
      const result = await recoverRoomsOnStartup(h.deps);
      expect(result.isolated).toHaveLength(1);
      expect(h.reserveRoomRevision).not.toHaveBeenCalled();
      expect(h.createRecoveredFresh).not.toHaveBeenCalled();
    }
  });

  it("reconciles an early FINISHED Room back to its committed running Tournament before registration", async () => {
    const record = { ...fixture(), status: "FINISHED" as const };
    const h = harness([record]);
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toEqual([]);
    expect(h.order).toEqual(["status:r1:IN_GAME", "start:t1"]);
    expect(h.roomManager.getSnapshot(record.roomId)?.activeTournamentId).toBe("t1");
  });

  it("isolates superseded running Tournaments and registers only the latest numbered round", async () => {
    const latest = fixture("r1", "t2");
    const old: RoomRecoveryTournament = {
      ...latest.tournaments[0]!,
      tournamentId: "t1",
      tournamentNo: 1,
    };
    const record = {
      ...latest,
      tournamentCount: 2,
      tournaments: [{ ...latest.tournaments[0]!, tournamentNo: 2 }, old],
    };
    const h = harness([record]);
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toEqual([
      { roomId: "r1", tournamentId: "t1", reason: "superseded-tournament" },
    ]);
    expect(h.createRecoveredFresh.mock.calls.map(([input]) => input.tournamentId)).toEqual(["t2"]);
    expect(h.roomManager.findRoom("r1")?.current.tournamentCount).toBe(2);
  });

  it("restores a committed terminal Room without restarting the finished round or a stale older round", async () => {
    const base = fixture("r1", "t2", 10n);
    const record: RoomRecoveryRecord = {
      ...base,
      tournamentCount: 2,
      tournaments: [
        { ...base.tournaments[0]!, tournamentNo: 2, status: "FINISHED" },
        { ...base.tournaments[0]!, tournamentId: "t1", tournamentNo: 1, status: "IN_GAME" },
      ],
    };
    const h = harness([record]);
    const snapshot = snapshotRecordFromBundle(makeBundle("t2", 2, 7n, 4));
    const previous = snapshot.state as TournamentState;
    const state: TournamentState = {
      ...previous,
      phase: "finished",
      champion: 0,
      participants: previous.participants.map((player) => ({
        ...player,
        status: player.seatIndex === 0 ? "ACTIVE" : "ELIMINATED",
        chips: player.seatIndex === 0 ? 300 : 0,
        finish:
          player.seatIndex === 0
            ? undefined
            : {
                placementRange: { from: 2, to: 3 },
                displayOrder: player.seatIndex,
              },
      })),
      eliminations: [{ handNumber: 2, placementRange: { from: 2, to: 3 }, players: [1, 2] }],
      finalStandings: previous.participants.map((player) => ({
        seatIndex: player.seatIndex,
        name: player.name,
        placementRange: player.seatIndex === 0 ? { from: 1, to: 1 } : { from: 2, to: 3 },
        displayOrder: player.seatIndex === 0 ? 1 : player.seatIndex,
      })),
    };
    h.recoveryRepo.setSnapshots([{ ...snapshot, state, stateChecksum: sha256Checksum(state) }]);
    h.recoveryRepo.eventCount = 10n;
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.restoredRooms).toEqual([record.roomId]);
    expect(result.isolated).toEqual([
      { roomId: "r1", tournamentId: "t1", reason: "superseded-tournament" },
    ]);
    expect(h.roomManager.getSnapshot(record.roomId)).toMatchObject({
      status: "FINISHED",
      activeTournamentId: null,
    });
    expect(h.setRoomStatus).toHaveBeenCalledWith(record.roomId, "FINISHED");
    expect(h.createRecovered).not.toHaveBeenCalled();
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
  });

  it("commits a validated fallback before starting its runtime", async () => {
    const h = harness([fixture("r1", "t1", 14n)]);
    h.recoveryRepo.setSnapshots([snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4))]);
    h.recoveryRepo.eventCount = 14n;
    const rollback = vi.spyOn(h.recoveryRepo, "rollbackToSnapshot").mockImplementation(async () => {
      h.order.push("rollback:10");
    });
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.recovered).toEqual([{ tournamentId: "t1", fromSequence: 10n }]);
    expect(rollback).toHaveBeenCalledOnce();
    expect(h.order).toEqual(["rollback:10", "start:t1"]);
  });

  it("shares a concurrent barrier and skips an already registered Room on a later retry", async () => {
    const record = fixture();
    const h = harness([record]);
    let release!: (records: RoomRecoveryRecord[]) => void;
    h.listRecoverableRooms.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = recoverRoomsOnStartup(h.deps);
    const concurrent = recoverRoomsOnStartup(h.deps);
    expect(concurrent).toBe(first);
    release([record]);
    await first;
    const runtime = h.roomManager.findRoom(record.roomId);
    const retry = await recoverRoomsOnStartup(h.deps);
    expect(retry.skippedRooms).toEqual([record.roomId]);
    expect(h.roomManager.findRoom(record.roomId)).toBe(runtime);
    expect(h.createRecoveredFresh).toHaveBeenCalledOnce();
    expect(h.reserveRoomRevision).toHaveBeenCalledOnce();
  });

  it("removes the registered Room and invite route when Tournament startup fails, then permits retry", async () => {
    const record = fixture();
    const h = harness([record]);
    h.createRecoveredFresh.mockRejectedValueOnce(new Error("failed to start"));
    const first = await recoverRoomsOnStartup(h.deps);
    expect(first.restoredRooms).toEqual([]);
    expect(h.roomManager.findRoom(record.roomId)).toBeUndefined();
    await expect(
      h.roomManager.joinRoom({
        inviteCode: record.inviteCode!,
        displayName: "X",
        displayNameKey: "x",
      }),
    ).rejects.toThrow("INVALID_INVITE_CODE");
    const second = await recoverRoomsOnStartup(h.deps);
    expect(second.restoredRooms).toEqual([record.roomId]);
    expect(h.createRecoveredFresh).toHaveBeenCalledTimes(2);
  });

  it("rejects a Room whose revision reservation fails without registering its Tournament", async () => {
    const record = fixture();
    const h = harness([record]);
    h.reserveRoomRevision.mockRejectedValueOnce(new PersistenceError("ROOM_REVISION_RESERVATION_FAILED"));
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toHaveLength(1);
    expect(h.roomManager.findRoom(record.roomId)).toBeUndefined();
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
  });

  it.each([REVISION_CEILING, Number.MAX_SAFE_INTEGER])(
    "rejects all revision-changing commands at ceiling %s before memory or persistence changes",
    async (ceiling) => {
      const record = lobby();
      const h = harness([record]);
      await recoverRoomsOnStartup(h.deps);
      const initial = h.roomManager.findRoom(record.roomId)!.current;
      h.roomManager.unregisterRecovered(record.roomId);
      const atCeiling = { ...initial, roomRevision: ceiling };
      h.roomManager.registerRecovered(atCeiling, ceiling);
      const published = vi.fn();
      const unsubscribe = h.roomManager.subscribe(published);
      for (const command of [
        { type: "SET_READY" as const, playerId: record.hostPlayerId!, ready: true },
        {
          type: "CHANGE_SEAT" as const,
          playerId: record.hostPlayerId!,
          seat: 0,
          expectedRevision: ceiling,
        },
      ]) {
        await expect(h.roomManager.submitCommand(record.roomId, command)).rejects.toThrow(
          "GAME_UNAVAILABLE",
        );
        expect(h.roomManager.findRoom(record.roomId)!.current).toBe(atCeiling);
        expect(h.persistence.calls).toEqual([]);
        expect(published).not.toHaveBeenCalled();
      }
      unsubscribe();
    },
  );

  it("rejects checksum-correct terminal checkpoints that still contain multiple ACTIVE players", async () => {
    const base = fixture("r1", "t1", 10n);
    const record = {
      ...base,
      status: "FINISHED" as const,
      tournaments: [{ ...base.tournaments[0]!, status: "FINISHED" as const }],
    };
    const h = harness([record]);
    const snapshot = snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4));
    const state = { ...(snapshot.state as object), phase: "finished" };
    h.recoveryRepo.setSnapshots([{ ...snapshot, state, stateChecksum: sha256Checksum(state) }]);
    h.recoveryRepo.eventCount = 10n;
    const result = await recoverRoomsOnStartup(h.deps);
    expect(result.isolated).toHaveLength(1);
    expect(h.roomManager.findRoom(record.roomId)).toBeUndefined();
  });

  it("propagates an unavailable recovery database so the caller cannot open its listener", async () => {
    const h = harness([fixture()]);
    h.listRecoverableRooms.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recoverRoomsOnStartup(h.deps)).rejects.toThrow("ROOM_RECOVERY_INFRASTRUCTURE_FAILED:list-rooms");
    expect(h.roomManager.activeRoomCount()).toBe(0);
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
  });

  it("redacts a failure from the initial active-tournament database read", async () => {
    const h = harness([fixture()]);
    vi.spyOn(h.recoveryRepo, "listActiveTournaments").mockRejectedValueOnce(new Error("private SQL parameters"));
    await expect(recoverRoomsOnStartup(h.deps)).rejects.toThrow("ROOM_RECOVERY_INFRASTRUCTURE_FAILED:list-active-tournaments");
    expect(h.onIsolated).not.toHaveBeenCalled();
    expect(h.roomManager.activeRoomCount()).toBe(0);
  });

  it.each(([
    "list-snapshots", "check-event-continuity", "rollback-snapshot", "reserve-room-revision", "set-room-status",
  ] as const).flatMap(operation => [{ operation, infrastructure: true }, { operation, infrastructure: false }]))(
    "$operation distinguishes infrastructure failure ($infrastructure) from known per-room inconsistency",
    async ({ operation, infrastructure }) => {
      const record = { ...fixture("r1", "t1", 14n), status: "FINISHED" as const };
      const healthy = lobby(fixture("r2", "t2"));
      const h = harness([record, healthy]);
      h.recoveryRepo.setSnapshots([snapshotRecordFromBundle(makeBundle("t1", 2, 7n, 4))]);
      h.recoveryRepo.eventCount = 14n;
      const failure = infrastructure
        ? Object.assign(new Error("private SQL parameters and credential contents"), { code: operation === "reserve-room-revision" ? "42703" : "ECONNRESET" })
        : new PersistenceError("known target/checkpoint/reservation inconsistency");
      switch (operation) {
        case "list-snapshots": vi.spyOn(h.recoveryRepo, "listSnapshots").mockRejectedValueOnce(failure); break;
        case "check-event-continuity": vi.spyOn(h.recoveryRepo, "hasCommittedEventsThrough").mockRejectedValueOnce(failure); break;
        case "rollback-snapshot": vi.spyOn(h.recoveryRepo, "rollbackToSnapshot").mockRejectedValueOnce(failure); break;
        case "reserve-room-revision": h.reserveRoomRevision.mockRejectedValueOnce(failure); break;
        case "set-room-status": h.setRoomStatus.mockRejectedValueOnce(failure); break;
      }
      if (infrastructure) {
        const error: unknown = await recoverRoomsOnStartup(h.deps).catch(error => error);
        expect(error).toMatchObject({ name: "RecoveryInfrastructureError", message: `ROOM_RECOVERY_INFRASTRUCTURE_FAILED:${operation}` });
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toContain("private SQL");
        expect(h.onIsolated).not.toHaveBeenCalled();
        expect(h.roomManager.activeRoomCount()).toBe(0);
        expect(h.createRecovered).not.toHaveBeenCalled();
        expect(h.createRecoveredFresh).not.toHaveBeenCalled();
        // A failed startup releases its barrier; a caller can retry after repairing the database.
        const retried = await recoverRoomsOnStartup(h.deps);
        expect(retried.restoredRooms).toEqual([record.roomId, healthy.roomId]);
      } else {
        const result = await recoverRoomsOnStartup(h.deps);
        expect(result.isolated).toEqual([{ roomId: record.roomId, tournamentId: "t1", reason: "recovery-validation-or-registration-failed" }]);
        expect(result.restoredRooms).toEqual([healthy.roomId]);
        expect(h.roomManager.findRoom(record.roomId)).toBeUndefined();
      }
    },
  );

  it("does not mistake an Engine construction failure for repository infrastructure failure", async () => {
    const record = fixture();
    const healthy = lobby(fixture("r2", "t2"));
    const h = harness([record, healthy]);
    const result = await recoverRoomsOnStartup({
      ...h.deps,
      rngFactory: () => { throw Object.assign(new Error("failed engine random source"), { code: "ECONNRESET" }); },
    });
    expect(result.isolated).toEqual([{ roomId: record.roomId, tournamentId: "t1", reason: "recovery-validation-or-registration-failed" }]);
    expect(result.restoredRooms).toEqual([healthy.roomId]);
    expect(h.createRecoveredFresh).not.toHaveBeenCalled();
  });
});
