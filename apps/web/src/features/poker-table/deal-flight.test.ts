import { describe, expect, it } from "vitest";

import { dealFlightVector } from "./deal-flight";

describe("dealFlightVector", () => {
  it("starts every hand-card flight at the shared deck and reaches the requested seat", () => {
    expect(dealFlightVector({ width: 1200, height: 700 }, { left: "50%", top: "8%" })).toEqual({ x: 0, y: -434 });
    expect(dealFlightVector({ width: 1200, height: 700 }, { left: "91%", top: "64%" })).toEqual({ x: 492, y: -42 });
    expect(dealFlightVector({ width: 1200, height: 700 }, { left: "50%", top: "93%" })).toEqual({ x: 0, y: 161 });
  });
});
