import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@texas-holdem/protocol";

import { gameSnapshot, roomSnapshot } from "../testing-fixtures";
import { ProjectionStore } from "./projection-store";

function event(sequence: string, tournamentId = "tournament-1") {
  return {
    type: "GAME_EVENT" as const,
    protocolVersion: PROTOCOL_VERSION,
    serverTime: 1,
    payload: {
      tournamentId,
      sequence,
      handId: "hand-1",
      event: { type: "PLAYER_CHECKED" as const, payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" as const } },
      patch: { currentActorPlayerId: "player-2", viewer: { legalActions: null } },
    },
  };
}

describe("ProjectionStore", () => {
  it("accepts a new room even when its independent revision is lower", () => {
    const store = new ProjectionStore();
    store.acceptRoomSnapshot(roomSnapshot({ roomId: "room-a", roomRevision: "9007199254740992" }));
    store.acceptRoomSnapshot(roomSnapshot({ roomId: "room-b", roomRevision: "1" }));
    expect(store.getSnapshot().room).toMatchObject({ roomId: "room-b", roomRevision: "1" });
  });

  it("atomically replaces both projections at the reconnect barrier, including a null game", () => {
    const store = new ProjectionStore();
    store.acceptReconnectResult(roomSnapshot({ roomId: "room-a" }), gameSnapshot());
    store.acceptReconnectResult(roomSnapshot({ roomId: "room-b", roomRevision: "1", activeTournamentId: null }), null);
    expect(store.getSnapshot()).toMatchObject({ room: { roomId: "room-b" }, game: null, lastSequence: null, actionsDisabled: false });
  });

  it("atomically replaces snapshots and applies the next event across Number.MAX_SAFE_INTEGER", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("APPLIED");
    expect(store.getSnapshot().lastSequence).toBe("9007199254740992");
    expect(store.getSnapshot().game?.currentActorPlayerId).toBe("player-2");
  });

  it("notifies presentation only after a continuous event commits, while snapshots are barriers", () => {
    const store = new ProjectionStore();
    const accepted: string[] = [];
    const barriers: string[] = [];
    store.subscribeAcceptedGameEvents((next) => accepted.push(`${next.message.payload.sequence}:${next.afterCanonical.sequence}`));
    store.subscribeBarriers((next) => barriers.push(`${next.kind}:${next.game?.sequence ?? "none"}`));
    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("APPLIED");
    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("IGNORED");
    store.acceptReconnectResult(roomSnapshot(), gameSnapshot({ sequence: "9007199254741000" }));
    expect(accepted).toEqual(["9007199254740992:9007199254740992"]);
    expect(barriers).toEqual(["GAME_SNAPSHOT:9007199254740991", "RECONNECT_RESULT:9007199254741000"]);
  });

  it("commits canonical and history once before notifying animation, and clears history before barriers", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    const notifications: string[] = [];
    store.subscribe(() => notifications.push("state"));
    store.subscribeAcceptedGameEvents((accepted) => {
      notifications.push("animation");
      expect(store.getSnapshot().game).toBe(accepted.afterCanonical);
      expect(store.getSnapshot().currentHandEvents).toEqual([{
        handId: accepted.message.payload.handId,
        sequence: accepted.message.payload.sequence,
        event: accepted.message.payload.event,
      }]);
    });
    store.subscribeBarriers((barrier) => {
      notifications.push(barrier.kind);
      expect(store.getSnapshot().game).toBe(barrier.game);
      expect(store.getSnapshot().currentHandEvents).toEqual([]);
    });

    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("APPLIED");
    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("IGNORED");
    expect(notifications).toEqual(["state", "animation"]);
    store.acceptGameSnapshot(gameSnapshot({ sequence: "9007199254740993" }));
    expect(store.acceptGameEvent(event("9007199254740994"))).toBe("APPLIED");
    store.acceptReconnectResult(roomSnapshot(), gameSnapshot({ sequence: "9007199254740995" }));
    expect(notifications).toEqual(["state", "animation", "state", "GAME_SNAPSHOT", "state", "animation", "state", "RECONNECT_RESULT"]);
  });

  it("ignores duplicate events and pauses actions on gaps, disorder, and a mismatched tournament", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(event("9007199254740991"))).toBe("IGNORED");
    expect(store.acceptGameEvent(event("9007199254740993"))).toBe("RESYNC");
    expect(store.getSnapshot()).toMatchObject({ actionsDisabled: true, resyncReason: "GAP" });

    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(event("9007199254740992", "other-tournament"))).toBe("RESYNC");
    expect(store.getSnapshot().actionsDisabled).toBe(true);
  });

  it("rejects an event that attempts to expose another player's private card", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    const privateCard = {
      ...event("9007199254740992"),
      payload: {
        ...event("9007199254740992").payload,
        event: { type: "DEAL_HOLE_CARD" as const, payload: { playerId: "player-2", seat: 1, cardIndex: 0 as const, card: { rank: "Q" as const, suit: "HEARTS" as const } } },
      },
    };
    expect(store.acceptGameEvent(privateCard)).toBe("RESYNC");
    expect(store.getSnapshot().game?.sequence).toBe("9007199254740991");
  });

  it("rejects a continuous patch whose envelope hand identity cannot be reconciled", () => {
    const store = new ProjectionStore();
    const accepted: string[] = [];
    store.subscribeAcceptedGameEvents((next) => accepted.push(next.message.payload.sequence));
    store.acceptGameSnapshot(gameSnapshot());
    const mismatched = {
      ...event("9007199254740992"),
      payload: { ...event("9007199254740992").payload, handId: "other-hand" },
    };

    expect(store.acceptGameEvent(mismatched)).toBe("RESYNC");
    expect(store.getSnapshot()).toMatchObject({ lastSequence: "9007199254740991", actionsDisabled: true, resyncReason: "INVALID_EVENT", currentHandEvents: [] });
    expect(accepted).toEqual([]);
  });

  it("accepts only a current, non-stale display clock without changing game state", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot(), 10);
    const before = store.getSnapshot().game;
    store.acceptClockUpdated({ tournamentId: "tournament-1", handId: "hand-1", currentActorPlayerId: "player-1", actionDeadline: 20_000, timeBankRemainingMs: 30_000 }, 11);
    expect(store.getSnapshot().clock).toMatchObject({ actionDeadline: 20_000, timeBankRemainingMs: 30_000 });
    expect(store.getSnapshot().game).toBe(before);

    store.acceptClockUpdated({ tournamentId: "tournament-1", handId: "hand-1", currentActorPlayerId: "player-2", actionDeadline: 99_000, timeBankRemainingMs: 0 }, 12);
    store.acceptClockUpdated({ tournamentId: "tournament-1", handId: "hand-1", currentActorPlayerId: "player-1", actionDeadline: 99_000, timeBankRemainingMs: 0 }, 9);
    expect(store.getSnapshot().clock).toMatchObject({ actionDeadline: 20_000, timeBankRemainingMs: 30_000 });
  });
});

describe("ProjectionStore current-hand event buffer", () => {
  function handEvent(sequence: string, handId: string) {
    return {
      ...event(sequence),
      payload: {
        ...event(sequence).payload,
        handId,
        event: { type: "PLAYER_CHECKED" as const, payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" as const } },
      },
    };
  }

  it("buffers applied events of the running hand in sequence order", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    store.acceptGameEvent(handEvent("9007199254740992", "hand-1"));
    store.acceptGameEvent(handEvent("9007199254740993", "hand-1"));
    expect(store.getSnapshot().currentHandEvents.map((entry) => [entry.handId, entry.sequence])).toEqual([
      ["hand-1", "9007199254740992"],
      ["hand-1", "9007199254740993"],
    ]);
  });

  it("does not buffer ignored or resync-triggering events", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(handEvent("9007199254740991", "hand-1"))).toBe("IGNORED");
    expect(store.acceptGameEvent(handEvent("9007199254740995", "hand-1"))).toBe("RESYNC");
    expect(store.getSnapshot().currentHandEvents).toEqual([]);
  });

  it("starts a fresh buffer when the next hand begins so a settled hand never leaks", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    store.acceptGameEvent(handEvent("9007199254740992", "hand-1"));
    const nextHand = handEvent("9007199254740993", "hand-2");
    expect(store.acceptGameEvent({
      ...nextHand,
      payload: {
        ...nextHand.payload,
        event: { type: "HAND_STARTED", payload: { handNumber: 2, dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0, blindLevel: 0 } },
        patch: { handId: "hand-2", handPhase: "PREFLOP", dealerSeat: 1, board: [] },
      },
    })).toBe("APPLIED");
    expect(store.getSnapshot().currentHandEvents.map((entry) => entry.handId)).toEqual(["hand-2"]);
  });

  it("clears the buffer on a game snapshot and on a reconnect barrier", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    store.acceptGameEvent(handEvent("9007199254740992", "hand-1"));
    store.acceptGameSnapshot(gameSnapshot({ sequence: "9007199254740993" }));
    expect(store.getSnapshot().currentHandEvents).toEqual([]);

    store.acceptGameEvent(handEvent("9007199254740994", "hand-1"));
    store.acceptReconnectResult(roomSnapshot(), gameSnapshot({ sequence: "9007199254740995" }));
    expect(store.getSnapshot().currentHandEvents).toEqual([]);
  });
});
