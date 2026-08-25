import { describe, expect, it } from "vitest";

import { standardConfig } from "./room-presets";

describe("standard lobby preset", () => {
  it("uses the documented 5-minute blind schedule instead of a single permanent level", () => {
    expect(standardConfig.blindMode).toBe("time");
    expect(standardConfig.blindStructure).toHaveLength(17);
    expect(standardConfig.blindStructure.map((level) => [level.smallBlind, level.bigBlind])).toEqual([
      [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600],
      [400, 800], [600, 1_200], [800, 1_600], [1_000, 2_000], [1_500, 3_000],
      [2_000, 4_000], [3_000, 6_000], [5_000, 10_000], [7_500, 15_000],
      [10_000, 20_000], [15_000, 30_000],
    ]);
    expect(standardConfig.blindStructure.every((level) => level.durationSeconds === 300)).toBe(true);
  });
});
