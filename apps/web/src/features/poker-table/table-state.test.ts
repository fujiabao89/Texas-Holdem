import { describe, expect, it } from "vitest";

import type { GameSnapshot } from "@texas-holdem/protocol";

import { gameSnapshot } from "../../testing-fixtures";
import { canSubmitTableAction, remainingTimeMs, seatBadges, tableSeatSlots, tableSeats } from "./table-state";

type TestPlayer = GameSnapshot["players"][number];

function player(seat: number, overrides: Partial<TestPlayer> = {}): TestPlayer {
  return {
    playerId: `player-${seat}`,
    displayName: `玩家${seat}`,
    seat,
    stack: 1_000,
    streetBet: 0,
    totalCommitted: 0,
    pokerStatus: "ACTIVE",
    hasHoleCards: true,
    revealedCards: [],
    ...overrides,
  };
}

function snapshotFor(players: readonly TestPlayer[], viewerSeat: number, overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return gameSnapshot({
    players: [...players],
    viewer: { ...gameSnapshot().viewer, playerId: `player-${viewerSeat}` },
    ...overrides,
  });
}

describe("poker table presentation state", () => {
  it("only exposes the server-provided legal actions to the current actor on a live connection", () => {
    const game = gameSnapshot();
    expect(canSubmitTableAction(game, "CONNECTED", false, false)).toBe(true);
    expect(canSubmitTableAction({ ...game, currentActorPlayerId: "player-2" }, "CONNECTED", false, false)).toBe(false);
    expect(canSubmitTableAction(game, "RESYNCING", false, false)).toBe(false);
    expect(canSubmitTableAction(game, "CONNECTED", true, false)).toBe(false);
    expect(canSubmitTableAction(game, "CONNECTED", false, true)).toBe(false);
  });

  it("renders seat capacity without inventing players or changing server seat assignments", () => {
    const seats = tableSeats(gameSnapshot());
    expect(seats).toHaveLength(10);
    expect(seats[0]?.playerId).toBe("player-1");
    expect(seats[1]?.playerId).toBe("player-2");
    expect(seats.slice(2)).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("derives a display-only countdown from the latest server-time anchor", () => {
    expect(remainingTimeMs(20_000, 10_000, 500, 2_500)).toBe(8_000);
    expect(remainingTimeMs(20_000, 10_000, 500, 50_000)).toBe(0);
    expect(remainingTimeMs(null, 10_000, 500, 2_500)).toBeNull();
  });
});

describe("stable seat mapping", () => {
  it("keeps the viewer at the bottom centre and maps opponents by clockwise seat offset", () => {
    const slots = tableSeatSlots(snapshotFor([0, 1, 2, 3, 4, 5].map((seat) => player(seat)), 3));
    expect(slots[3]).toBe(5);
    expect(slots[4]).toBe(6);
    expect(slots[5]).toBe(7);
    expect(slots[0]).toBe(2);
    expect(slots[1]).toBe(3);
    expect(slots[2]).toBe(4);
  });

  it("assigns a unique stable slot for every 2–10 player table and viewer seat", () => {
    for (let count = 2; count <= 10; count += 1) {
      for (let viewerSeat = 0; viewerSeat < count; viewerSeat += 1) {
        const slots = tableSeatSlots(snapshotFor(Array.from({ length: count }, (_, seat) => player(seat)), viewerSeat));
        const occupied = slots.filter((slot): slot is number => slot !== null);
        expect(occupied).toHaveLength(count);
        expect(new Set(occupied).size).toBe(count);
        expect(slots[viewerSeat]).toBe(5);
      }
    }
  });

  it("does not reorder seats when actor, stacks, connection states, poker statuses or player order change", () => {
    const before = tableSeatSlots(snapshotFor([0, 1, 2, 3, 4, 5].map((seat) => player(seat)), 2, { currentActorPlayerId: "player-2" }));
    const after = tableSeatSlots(snapshotFor([
      player(5, { displayName: "超长昵称超长昵称超长昵称" }),
      player(0, { pokerStatus: "ELIMINATED", stack: 0 }),
      player(4, { hasHoleCards: false, streetBet: 400 }),
      player(1, { pokerStatus: "WITHDRAWN", stack: 0 }),
      player(3, { pokerStatus: "EXIT_PENDING" }),
      player(2, { stack: 12_345 }),
    ], 2, { currentActorPlayerId: "player-4" }));
    expect(after).toEqual(before);
  });

  it("keeps the remaining seats in place when a player leaves the table", () => {
    const before = tableSeatSlots(snapshotFor([0, 1, 2, 3].map((seat) => player(seat)), 1));
    const after = tableSeatSlots(snapshotFor([0, 1, 3].map((seat) => player(seat)), 1));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).toBe(before[3]);
    expect(after[2]).toBeNull();
  });

  it("returns no slots when the viewer is missing from the projection", () => {
    expect(tableSeatSlots(snapshotFor([0, 1].map((seat) => player(seat)), 9))).toEqual(Array(10).fill(null));
  });
});

describe("seat position badges", () => {
  it("marks the dealer, small blind and big blind seats", () => {
    const game = snapshotFor([0, 1, 2].map((seat) => player(seat)), 0, { dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2 });
    expect(seatBadges(game, 0)).toEqual(["D"]);
    expect(seatBadges(game, 1)).toEqual(["SB"]);
    expect(seatBadges(game, 2)).toEqual(["BB"]);
    expect(seatBadges(game, 3)).toEqual([]);
  });

  it("shows both D and SB on the heads-up button seat", () => {
    const game = snapshotFor([0, 1].map((seat) => player(seat)), 0, { dealerSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1 });
    expect(seatBadges(game, 0)).toEqual(["D", "SB"]);
    expect(seatBadges(game, 1)).toEqual(["BB"]);
  });

  it("shows no blind badges between hands while keeping the tournament dealer", () => {
    const game = snapshotFor([0, 1].map((seat) => player(seat)), 0, { handId: null, handPhase: null, dealerSeat: 1, smallBlindSeat: null, bigBlindSeat: null });
    expect(seatBadges(game, 1)).toEqual(["D"]);
    expect(seatBadges(game, 0)).toEqual([]);
  });
});
