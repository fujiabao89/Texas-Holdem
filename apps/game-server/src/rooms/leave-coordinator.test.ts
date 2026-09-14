import { describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "@texas-holdem/protocol";
import type { TournamentManager } from "../tournaments/tournament-manager";
import { leaveRoomMember } from "./leave-coordinator";
import { RoomDomainError } from "./room-errors";
import type { RoomManager, RoomSnapshotListener } from "./room-manager";
import { closeRoom, createRoomState, projectRoomSnapshot } from "./room-runtime";

function fixture() {
  const state = createRoomState({
    roomId: "r1",
    inviteCode: "ABCDEF",
    host: {
      playerId: "p1",
      displayName: "Host",
      displayNameKey: "host",
      joinedAt: 1,
      tokenDigest: Buffer.alloc(32),
      tokenKeyId: "test",
    },
    config: {
      maxPlayers: 2,
      startingStack: 1000,
      smallBlind: 5,
      bigBlind: 10,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
      actionTime: 30,
      timeBank: 0,
    },
  });
  const active: RoomSnapshot = {
    ...projectRoomSnapshot(state),
    status: "IN_GAME",
    activeTournamentId: "t1",
  };
  const closed = projectRoomSnapshot(closeRoom(state, "ABANDONED_NO_HUMAN"));
  const listeners = new Set<RoomSnapshotListener>();
  const unsubscribe = vi.fn();
  let tombstone = false;
  const missing = new RoomDomainError("ROOM_NOT_FOUND");
  const manager = {
    subscribe: vi.fn((listener: RoomSnapshotListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
    getSnapshot: vi.fn((): RoomSnapshot | undefined => active),
    getTombstone: vi.fn(() =>
      tombstone ? { roomId: "r1", closedReason: "ABANDONED_NO_HUMAN", closedAt: 2 } : undefined,
    ),
    submitCommand: vi.fn(async () => {
      throw missing;
    }),
  };
  const tournaments = { submit: vi.fn(async () => undefined) };
  const emit = (snapshot = closed) => {
    for (const listener of listeners) listener(snapshot);
  };
  const close = () => {
    tombstone = true;
    emit();
  };
  const run = () =>
    leaveRoomMember({
      manager: manager as unknown as RoomManager,
      tournaments: tournaments as unknown as TournamentManager,
      roomId: "r1",
      playerId: "p1",
      now: () => 2,
      connectionEpoch: 7,
    });
  return {
    manager,
    tournaments,
    listeners,
    unsubscribe,
    closed,
    missing,
    emit,
    close,
    run,
    markTombstone: () => {
      tombstone = true;
    },
  };
}

describe("leaveRoomMember authoritative closure proof", () => {
  it("returns only the CLOSED snapshot observed after subscribing and successful withdrawal", async () => {
    const h = fixture();
    h.tournaments.submit.mockImplementation(async () => {
      h.close();
    });
    expect(await h.run()).toBe(h.closed);
    expect(h.manager.submitCommand).not.toHaveBeenCalled();
    expect(h.tournaments.submit).toHaveBeenCalledWith("t1", {
      type: "WITHDRAW_PLAYER",
      playerId: "p1",
      reason: "USER_LEFT",
      connectionEpoch: 7,
    });
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
  });

  it.each(["ROOM_NOT_FOUND", "ROOM_LOCKED"] as const)(
    "accepts queued %s only when closure is observed during that same leave",
    async (code) => {
      const h = fixture();
      h.manager.submitCommand.mockImplementation(async () => {
        h.close();
        throw new RoomDomainError(code);
      });
      expect(await h.run()).toBe(h.closed);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it.each(["none", "snapshot_only", "tombstone_only", "another_room"] as const)(
    "does not turn ROOM_NOT_FOUND into success with incomplete evidence: %s",
    async (evidence) => {
      const h = fixture();
      h.tournaments.submit.mockImplementation(async () => {
        if (evidence === "snapshot_only") h.emit();
        if (evidence === "tombstone_only" || evidence === "another_room") h.markTombstone();
        if (evidence === "another_room") h.emit({ ...h.closed, roomId: "r2" });
      });
      await expect(h.run()).rejects.toBe(h.missing);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
      expect(h.listeners.size).toBe(0);
    },
  );

  it("does not conceal a failed withdrawal even if a concurrent closure was observed", async () => {
    const h = fixture();
    const failure = new RoomDomainError("SESSION_REPLACED");
    h.tournaments.submit.mockImplementation(async () => {
      h.close();
      throw failure;
    });
    await expect(h.run()).rejects.toBe(failure);
    expect(h.manager.submitCommand).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not conceal an unrelated membership cleanup failure", async () => {
    const h = fixture();
    const failure = new Error("persistence unavailable");
    h.manager.submitCommand.mockImplementation(async () => {
      h.close();
      throw failure;
    });
    await expect(h.run()).rejects.toBe(failure);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
