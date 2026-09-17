import { describe, expect, it } from "vitest";

import { gameSnapshot, roomSnapshot } from "../../testing-fixtures";
import { canPlayAgain, resultAvailableFor, resultChampion, resultRows, resultSnapshotUnreachable } from "./result-view";

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

  it("flags tied placements from the server placement range without inventing champions", () => {
    const tied = gameSnapshot({
      tournamentStatus: "FINISHED",
      players: [
        { playerId: "player-1", displayName: "玩家甲", seat: 0, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
        { playerId: "player-2", displayName: "玩家乙", seat: 1, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
      ],
      rankings: [
        { playerId: "player-1", placement: { from: 1, to: 2 }, displayOrder: 1 },
        { playerId: "player-2", placement: { from: 1, to: 2 }, displayOrder: 2 },
      ],
    });
    const rows = resultRows(tied);
    expect(rows.every((row) => row.tied && row.place === 1 && !row.champion)).toBe(true);
    expect(resultRows(finishedGame).every((row) => !row.tied)).toBe(true);

    const champ = resultChampion(tied);
    expect(champ).toEqual({ hasChampion: false, playerId: null, displayName: null, finalChips: 0 });
  });

  it("sorts rankings by placement.from then displayOrder, preventing subsequent ranks from interleaving into tie groups", () => {
    const game = gameSnapshot({
      tournamentStatus: "FINISHED",
      players: [
        { playerId: "p-1", displayName: "玩家1", seat: 0, stack: 2000, streetBet: 0, totalCommitted: 0, pokerStatus: "ACTIVE", hasHoleCards: false, revealedCards: [] },
        { playerId: "p-2", displayName: "玩家2", seat: 1, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
        { playerId: "p-3", displayName: "玩家3", seat: 2, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
        { playerId: "p-4", displayName: "玩家4", seat: 3, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
      ],
      rankings: [
        { playerId: "p-4", placement: { from: 4, to: 4 }, displayOrder: 1 },
        { playerId: "p-3", placement: { from: 2, to: 3 }, displayOrder: 2 },
        { playerId: "p-1", placement: { from: 1, to: 1 }, displayOrder: 1 },
        { playerId: "p-2", placement: { from: 2, to: 3 }, displayOrder: 1 },
      ],
    });
    const rows = resultRows(game);
    expect(rows.map((r) => r.playerId)).toEqual(["p-1", "p-2", "p-3", "p-4"]);
    expect(rows.map((r) => r.place)).toEqual([1, 2, 2, 4]);
  });

  it("falls back to the opaque player id and zero chips when the ranking references an unknown player", () => {
    const orphan = gameSnapshot({
      tournamentStatus: "FINISHED",
      players: [
        { playerId: "player-gone", displayName: "player-gone", seat: 0, stack: 1000, streetBet: 0, totalCommitted: 0, pokerStatus: "ACTIVE", hasHoleCards: false, revealedCards: [] },
      ],
      rankings: [{ playerId: "player-gone", placement: { from: 1, to: 1 }, displayOrder: 1 }],
    });
    expect(resultRows(orphan)[0]).toMatchObject({ displayName: "player-gone", finalChips: 1000, champion: true });
  });

  describe("with TournamentResult (TEX-54 / TEX-55)", () => {
    const authoritativeResult = {
      tournamentId: "t-1",
      status: "FINISHED" as const,
      championPlayerId: "player-2",
      players: [
        { playerId: "player-1", displayName: "玩家甲", seat: 0, kind: "HUMAN" as const, pokerStatus: "ELIMINATED" as const, finalStack: 0 },
        { playerId: "player-2", displayName: "玩家乙", seat: 1, kind: "HUMAN" as const, pokerStatus: "ACTIVE" as const, finalStack: 3000 },
        { playerId: "player-3", displayName: "玩家丙", seat: 2, kind: "HUMAN" as const, pokerStatus: "WITHDRAWN" as const, finalStack: 0 },
      ],
      rankings: [
        { playerId: "player-2", placement: { from: 1, to: 1 }, displayOrder: 1 },
        { playerId: "player-1", placement: { from: 2, to: 2 }, displayOrder: 1 },
      ],
      finishedAt: 1700000000000,
    };

    it("maps finalStack and marks championPlayerId accurately", () => {
      const rows = resultRows(authoritativeResult);
      expect(rows.map((r) => r.playerId)).toEqual(["player-2", "player-1"]);
      expect(rows[0]).toMatchObject({ playerId: "player-2", champion: true, finalChips: 3000, place: 1, tied: false });
      expect(rows[1]).toMatchObject({ playerId: "player-1", champion: false, finalChips: 0, place: 2, tied: false });

      const champ = resultChampion(authoritativeResult);
      expect(champ).toEqual({ hasChampion: true, playerId: "player-2", displayName: "玩家乙", finalChips: 3000 });
    });

    it("respects championless finish without inventing a champion (ADR-0002)", () => {
      const championlessResult = {
        tournamentId: "t-2",
        status: "FINISHED" as const,
        championPlayerId: null,
        players: [
          { playerId: "player-1", displayName: "玩家甲", seat: 0, kind: "HUMAN" as const, pokerStatus: "WITHDRAWN" as const, finalStack: 0 },
          { playerId: "player-2", displayName: "玩家乙", seat: 1, kind: "HUMAN" as const, pokerStatus: "WITHDRAWN" as const, finalStack: 0 },
        ],
        rankings: [
          { playerId: "player-1", placement: { from: 1, to: 2 }, displayOrder: 1 },
          { playerId: "player-2", placement: { from: 1, to: 2 }, displayOrder: 2 },
        ],
        finishedAt: 1700000000000,
      };

      const rows = resultRows(championlessResult);
      expect(rows.every((r) => !r.champion)).toBe(true);
      expect(rows.every((r) => r.tied && r.place === 1)).toBe(true);

      const champ = resultChampion(championlessResult);
      expect(champ).toEqual({ hasChampion: false, playerId: null, displayName: null, finalChips: 0 });
    });

    it("sorts rankings by placement.from then displayOrder in TournamentResult", () => {
      const result = {
        ...authoritativeResult,
        players: [
          ...authoritativeResult.players,
          { playerId: "player-4", displayName: "玩家丁", seat: 3, kind: "HUMAN" as const, pokerStatus: "ELIMINATED" as const, finalStack: 0 },
        ],
        rankings: [
          { playerId: "player-4", placement: { from: 4, to: 4 }, displayOrder: 1 },
          { playerId: "player-3", placement: { from: 2, to: 3 }, displayOrder: 2 },
          { playerId: "player-2", placement: { from: 1, to: 1 }, displayOrder: 1 },
          { playerId: "player-1", placement: { from: 2, to: 3 }, displayOrder: 1 },
        ],
      };
      const rows = resultRows(result);
      expect(rows.map((r) => r.playerId)).toEqual(["player-2", "player-1", "player-3", "player-4"]);
      expect(rows.map((r) => r.place)).toEqual([1, 2, 2, 4]);
    });
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
  it("allows only the host and only when room is FINISHED or LOBBY (never IN_GAME or CLOSED)", () => {
    expect(canPlayAgain("FINISHED", true)).toBe(true);
    expect(canPlayAgain("LOBBY", true)).toBe(true);
    expect(canPlayAgain("IN_GAME", true)).toBe(false);
    expect(canPlayAgain("CLOSED", true)).toBe(false);
    expect(canPlayAgain("FINISHED", false)).toBe(false);
    expect(canPlayAgain("LOBBY", false)).toBe(false);
  });
});
