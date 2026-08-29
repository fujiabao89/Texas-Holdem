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
      0,
      "seat",
    );
    const side = dealFlightVector(
      { width: 1200, height: 700 },
      { left: "91%", top: "64%" },
      outsideTopLeftDeck,
      1,
      "seat",
    );
    const lower = dealFlightVector(
      { width: 1200, height: 700 },
      { left: "50%", top: "93%" },
      outsideTopLeftDeck,
      0,
      "hole",
    );
    expect(upper.x).toBeCloseTo(546.8);
    expect(upper.y).toBe(38);
    expect(side.x).toBeCloseTo(1_065.2);
    expect(side.y).toBe(430);
    expect(lower.x).toBeCloseTo(538.4);
    expect(lower.y).toBe(633);
    // Every target gets a visible upward arc before its exact landing point.
    expect(upper.midY).toBeLessThan(upper.y * 0.58);
    expect(side.midY).toBeLessThan(side.y * 0.58);
    expect(lower.midY).toBeLessThan(lower.y * 0.58);
  });

  it("lands the two rounds on distinct sides of the same player hand", () => {
    const table = { width: 1200, height: 700 };
    const target = { left: "50%", top: "93%" };
    const origin = { x: 40, y: -24 };
    const first = dealFlightVector(table, target, origin, 0, "hole");
    const second = dealFlightVector(table, target, origin, 1, "hole");
    expect(second.x - first.x).toBeCloseTo(43.2);
    expect(second.y).toBe(first.y);
  });

  it("restarts the CSS flight for every player and card index", () => {
    expect(dealFlightKey("hand-1", "alice", 0)).not.toBe(dealFlightKey("hand-1", "bob", 0));
    expect(dealFlightKey("hand-1", "alice", 0)).not.toBe(dealFlightKey("hand-1", "alice", 1));
  });
});
