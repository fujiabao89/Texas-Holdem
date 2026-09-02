import { describe, expect, it } from "vitest";

import { gameSnapshot, roomSnapshot } from "../../testing-fixtures";
import { canPlayAgain, resultAvailableFor, resultRows, resultSnapshotUnreachable } from "./result-view";

const finishedGame = gameSnapshot({
  tournamentStatus: "FINISHED",
  players: [
    { playerId: "player-1", displayName: "玩家甲", seat: 0, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
    { playerId: "player-2", displayName: "玩家乙", seat: 1, stack: 2_000, streetBet: 0, totalCommitted: 0, pokerStatus: "ACTIVE", hasHoleCards: false, revealedCards: [] },
  ],
  rankings: [
    { playerId: "player-1", placement: { from: 2, to: 2 }, displayOrder: 2 },
    { playerId: "player-2", placement: { from: 1, to: 1 }, displayOrder: 1 },
  ],
});

describe("resultRows", () => {
  it("presents rows in the server-given displayOrder, never re-sorted by the UI", () => {
    const rows = resultRows(finishedGame);
    expect(rows.map((row) => row.playerId)).toEqual(["player-2", "player-1"]);
    expect(rows.map((row) => row.place)).toEqual([1, 2]);
  });

  it("marks only the first-place ranking as champion and reports the server stack as final chips", () => {
    const rows = resultRows(finishedGame);
    expect(rows[0]).toMatchObject({ champion: true, finalChips: 2_000, displayName: "玩家乙" });
    expect(rows[1]).toMatchObject({ champion: false, finalChips: 0, displayName: "玩家甲" });
  });

  it("flags tied placements from the server placement range", () => {
    const tied = gameSnapshot({
      tournamentStatus: "FINISHED",
      rankings: [
        { playerId: "player-1", placement: { from: 1, to: 2 }, displayOrder: 1 },
        { playerId: "player-2", placement: { from: 1, to: 2 }, displayOrder: 2 },
      ],
    });
    const rows = resultRows(tied);
    expect(rows.every((row) => row.tied && row.place === 1 && row.champion)).toBe(true);
    expect(resultRows(finishedGame).every((row) => !row.tied)).toBe(true);
  });

  it("falls back to the opaque player id and zero chips when the ranking references an unknown player", () => {
    const orphan = gameSnapshot({
      tournamentStatus: "FINISHED",
      rankings: [{ playerId: "player-gone", placement: { from: 1, to: 1 }, displayOrder: 1 }],
    });
    expect(resultRows(orphan)[0]).toMatchObject({ displayName: "player-gone", finalChips: 0, champion: true });
  });
});

describe("resultAvailableFor", () => {
  it("requires a loaded game for the exact tournament in the URL that is FINISHED", () => {
    expect(resultAvailableFor(null, "tournament-1")).toBe(false);
    expect(resultAvailableFor(finishedGame, "other-tournament")).toBe(false);
    expect(resultAvailableFor(gameSnapshot(), "tournament-1")).toBe(false);
    expect(resultAvailableFor(finishedGame, "tournament-1")).toBe(true);
  });
});

describe("resultSnapshotUnreachable", () => {
  it("is true once the room is loaded with no active tournament and no game snapshot", () => {
    const finishedRoom = roomSnapshot({ activeTournamentId: null });
    expect(resultSnapshotUnreachable(finishedRoom, "room-1", null)).toBe(true);
  });

  it("stays false while the room is loading, is another room, or still has state to arrive", () => {
    expect(resultSnapshotUnreachable(null, "room-1", null)).toBe(false);
    const otherRoom = roomSnapshot({ roomId: "room-2", activeTournamentId: null });
    expect(resultSnapshotUnreachable(otherRoom, "room-1", null)).toBe(false);
    expect(resultSnapshotUnreachable(roomSnapshot(), "room-1", null)).toBe(false);
    expect(resultSnapshotUnreachable(roomSnapshot(), "room-1", gameSnapshot())).toBe(false);
    expect(resultSnapshotUnreachable(roomSnapshot({ activeTournamentId: null }), "room-1", gameSnapshot())).toBe(false);
  });
});

describe("canPlayAgain", () => {
  it("allows only the host and only while the room is not closed", () => {
    expect(canPlayAgain("IN_GAME", true)).toBe(true);
    expect(canPlayAgain("LOBBY", true)).toBe(true);
    expect(canPlayAgain("FINISHED", true)).toBe(true);
    expect(canPlayAgain("CLOSED", true)).toBe(false);
    expect(canPlayAgain("IN_GAME", false)).toBe(false);
  });
});
