import { describe, expect, it } from "vitest";

import { dealFlightVector } from "./deal-flight";

describe("dealFlightVector", () => {
  it("starts every hand-card flight at the shared deck and reaches the requested seat", () => {
    const upper = dealFlightVector({ width: 1200, height: 700 }, { left: "50%", top: "8%" });
    const side = dealFlightVector({ width: 1200, height: 700 }, { left: "91%", top: "64%" });
    const lower = dealFlightVector({ width: 1200, height: 700 }, { left: "50%", top: "93%" });
    expect(upper).toMatchObject({ x: 0, y: -483, midX: 0 });
    expect(side).toMatchObject({ x: 492, y: -91, midX: 226.32000000000002 });
    expect(lower).toMatchObject({ x: 0, y: 112, midX: 0 });
    // Every target gets a visible upward arc before its exact landing point.
    expect(upper.midY).toBeLessThan(upper.y * 0.46);
    expect(side.midY).toBeLessThan(side.y * 0.46);
    expect(lower.midY).toBeLessThan(lower.y * 0.46);
  });
});
