import { describe, expect, it } from "vitest";

import { gameSnapshot } from "../testing-fixtures";
import { ProjectionStore } from "./projection-store";

function event(sequence: string, tournamentId = "tournament-1") {
  return {
    type: "GAME_EVENT" as const,
    protocolVersion: 1 as const,
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
  it("atomically replaces snapshots and applies the next event across Number.MAX_SAFE_INTEGER", () => {
    const store = new ProjectionStore();
    store.acceptGameSnapshot(gameSnapshot());
    expect(store.acceptGameEvent(event("9007199254740992"))).toBe("APPLIED");
    expect(store.getSnapshot().lastSequence).toBe("9007199254740992");
    expect(store.getSnapshot().game?.currentActorPlayerId).toBe("player-2");
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
});
