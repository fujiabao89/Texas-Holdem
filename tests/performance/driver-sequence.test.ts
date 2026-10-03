import { describe, expect, it } from "vitest";

import { countSequenceViolations } from "./driver";
import { MetricsCollector } from "./metrics";

const event = (sequence: string, tournamentId = "t1") => ({
  type: "GAME_EVENT",
  payload: { tournamentId, sequence },
});
const snapshot = (sequence: string, tournamentId = "t1") => ({
  type: "GAME_SNAPSHOT",
  payload: { tournamentId, sequence },
});
const reconnect = (sequence: string, tournamentId = "t1") => ({
  type: "RECONNECT_RESULT",
  payload: { gameSnapshot: { tournamentId, sequence } },
});

function violations(messages: { type: string; payload?: unknown }[]): number {
  const metrics = new MetricsCollector();
  const found = countSequenceViolations({ messages }, metrics);
  expect(metrics.snapshot().sequenceViolations).toBe(found);
  return found;
}

describe("performance sequence validation with authoritative snapshot barriers", () => {
  it("allows a snapshot to cover omitted events, then requires S+1", () => {
    expect(violations([event("1"), snapshot("10"), event("11"), event("12")])).toBe(0);
  });

  it("uses initial and reconnect snapshots as barriers", () => {
    expect(violations([reconnect("10"), event("11"), reconnect("20"), event("21")])).toBe(0);
    expect(violations([reconnect("10"), event("12")])).toBe(1);
  });

  it("allows same-sequence presentation snapshots without relaxing the next event", () => {
    expect(violations([event("10"), snapshot("10"), event("11")])).toBe(0);
    expect(violations([event("10"), snapshot("10"), event("12")])).toBe(1);
  });

  it("still rejects missing, duplicate and reordered events without a covering snapshot", () => {
    expect(violations([event("1"), event("3")])).toBe(1);
    expect(violations([event("1"), event("1")])).toBe(1);
    expect(violations([event("2"), event("1")])).toBe(1);
    expect(violations([event("1"), { type: "RESYNC_REQUIRED" }, event("3")])).toBe(1);
  });

  it("rejects a gap or covered event after a snapshot", () => {
    expect(violations([snapshot("10"), event("12")])).toBe(1);
    expect(violations([snapshot("10"), event("10")])).toBe(1);
  });

  it("rejects a snapshot rollback and keeps the newer barrier", () => {
    expect(violations([event("10"), snapshot("5"), event("11")])).toBe(1);
  });

  it("keeps separate tournament streams and ignores lobby-only reconnects", () => {
    expect(
      violations([
        snapshot("10"),
        snapshot("100", "t2"),
        { type: "RECONNECT_RESULT", payload: { gameSnapshot: null } },
        event("11"),
        event("101", "t2"),
      ]),
    ).toBe(0);
  });

  it("compares decimal sequences precisely above Number.MAX_SAFE_INTEGER", () => {
    expect(violations([snapshot("9007199254740992"), event("9007199254740993")])).toBe(0);
    expect(violations([event("9007199254740992"), event("9007199254740992")])).toBe(1);
  });
});
