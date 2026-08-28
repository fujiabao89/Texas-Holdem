import { describe, expect, it } from "vitest";

import { dealFlightKey, dealFlightOrigin, dealFlightVector } from "./deal-flight";

describe("dealFlightVector", () => {
  it("measures a shared flight origin in the white area outside the table's top-left", () => {
    const origin = dealFlightOrigin(
      { left: 100, top: 200 },
      { left: 116, top: 124, width: 40, height: 64 },
    );
    expect(origin).toEqual({ x: 36, y: -44 });
    expect(origin.x).toBeLessThan(120);
    expect(origin.y).toBeLessThan(0);
  });

  it("starts every hand-card flight at the shared deck and reaches the requested seat", () => {
    const outsideTopLeftDeck = { x: 40, y: -24 };
    const upper = dealFlightVector(
      { width: 1200, height: 700 },
      { left: "50%", top: "8%" },
      outsideTopLeftDeck,
    );
    const side = dealFlightVector(
      { width: 1200, height: 700 },
      { left: "91%", top: "64%" },
      outsideTopLeftDeck,
    );
    const lower = dealFlightVector(
      { width: 1200, height: 700 },
      { left: "50%", top: "93%" },
      outsideTopLeftDeck,
    );
    expect(upper).toMatchObject({ x: 560, y: 38 });
    expect(side).toMatchObject({ x: 1052, y: 430 });
    expect(lower).toMatchObject({ x: 560, y: 633 });
    // Every target gets a visible upward arc before its exact landing point.
    expect(upper.midY).toBeLessThan(upper.y * 0.46);
    expect(side.midY).toBeLessThan(side.y * 0.46);
    expect(lower.midY).toBeLessThan(lower.y * 0.46);
  });

  it("restarts the CSS flight for every player and card index", () => {
    expect(dealFlightKey("hand-1", "alice", 0)).not.toBe(dealFlightKey("hand-1", "bob", 0));
    expect(dealFlightKey("hand-1", "alice", 0)).not.toBe(dealFlightKey("hand-1", "alice", 1));
  });
});
