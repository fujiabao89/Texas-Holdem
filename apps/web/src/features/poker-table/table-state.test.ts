import { describe, expect, it } from "vitest";

import { gameSnapshot } from "../../testing-fixtures";
import { canSubmitTableAction, remainingTimeMs, tableSeats } from "./table-state";

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
