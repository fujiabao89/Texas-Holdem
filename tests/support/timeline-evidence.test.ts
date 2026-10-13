import { describe, expect, it } from "vitest";
import {
  safeDiagnostic,
  timelineViolations,
  authoritativeViolations,
  validGateStats,
  validGateReport,
  isSafeEvidence,
  type DomSample,
} from "./timeline-evidence";

describe("TEX-62 evidence gate", () => {
  it("checks automatic action time rather than the earlier timer callback ingress", () => {
    const action = {
      event: "AUTO_ACTION",
      tournamentId: "t",
      handId: "h",
      deadline: 15_000,
      firedAt: 14_999,
      timestamp: 15_000,
    };
    expect(authoritativeViolations([action])).toEqual([]);
    expect(authoritativeViolations([{ ...action, timestamp: 14_999 }])).toHaveLength(1);
    expect(
      authoritativeViolations([{ ...action, firedAt: 15_000, timestamp: 14_999 }]),
    ).toHaveLength(1);
  });
  it("rejects expected failures, diagnostic retries and missing required browsers even with green counts", () => {
    const test = {
      projectName: "chromium",
      expectedStatus: "passed",
      results: [{ status: "passed", retry: 0 }],
    };
    const report = {
      stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
      suites: [{ specs: [{ tests: [test] }] }],
    };
    expect(validGateReport(report, { chromium: 1 })).toBe(true);
    expect(validGateReport(report, { firefox: 1 })).toBe(false);
    expect(
      validGateReport(
        { ...report, suites: [{ specs: [{ tests: [{ ...test, expectedStatus: "failed" }] }] }] },
        { chromium: 1 },
      ),
    ).toBe(false);
    expect(
      validGateReport(
        {
          ...report,
          suites: [
            { specs: [{ tests: [{ ...test, results: [{ status: "passed", retry: 1 }] }] }] },
          ],
        },
        { chromium: 1 },
      ),
    ).toBe(false);
  });
  it("refuses export of known credentials, database URLs, raw payloads and private card structures", () => {
    expect(
      isSafeEvidence({ frames: [{ type: "GAME_EVENT", handId: "h", sequence: "1" }] }, [
        "known-player-secret",
      ]),
    ).toBe(true);
    for (const value of [
      { note: "known-player-secret" },
      { note: "postgres://test@localhost/db" },
      { frames: [{ payload: {} }] },
      { rank: "A", suit: "SPADES" },
    ])
      expect(isSafeEvidence(value, ["known-player-secret"])).toBe(false);
  });
  it("exports the closed diagnostic projection, never private payload or arbitrary stdout", () => {
    const line = JSON.stringify({
      app: "game-server",
      event: "HAND_STARTED",
      handId: "hand",
      timestamp: 10,
      payload: { playerToken: "secret", cards: "private" },
      headers: { authorization: "secret" },
      deck: "private",
    });
    expect(safeDiagnostic(line)).toEqual({ event: "HAND_STARTED", handId: "hand", timestamp: 10 });
    expect(safeDiagnostic("not-json secret")).toBeNull();
    expect(
      safeDiagnostic(JSON.stringify({ app: "game-server", event: "other", payload: "secret" })),
    ).toBeNull();
    expect(safeDiagnostic("null")).toBeNull();
  });
  it("rejects an action shown on the previous presentation hand", () => {
    const sample: DomSample = {
      at: 1,
      handId: "old",
      actionHandId: "new",
      outcomeHandId: "old",
      mode: "NORMAL",
      phase: "PREFLOP",
      reduced: false,
      visibility: "visible",
      kind: "mutation",
    };
    expect(timelineViolations([sample])).toHaveLength(2);
    expect(timelineViolations([{ ...sample, handId: "new", outcomeHandId: null }])).toEqual([]);
  });
  it("catches repeated starts, a consumed 4-second presentation budget and early automatic action", () => {
    const base = { tournamentId: "t", handId: "h", timestamp: 0 };
    expect(
      authoritativeViolations([
        { ...base, event: "HAND_STARTED" },
        { ...base, event: "HAND_STARTED" },
        { ...base, event: "PHASE_CHANGED", phase: "ACTION_OPEN", deadline: 11_000 },
        { ...base, event: "AUTO_ACTION", deadline: 11_000, firedAt: 10_000 },
      ]),
    ).toHaveLength(3);
    expect(
      authoritativeViolations([
        { ...base, event: "HAND_STARTED" },
        { ...base, event: "PHASE_CHANGED", phase: "ACTION_OPEN", deadline: 15_000 },
      ]),
    ).toEqual([]);
  });
  it("rejects a silent half-played settlement and empty/skipped/flaky reports", () => {
    const sample: DomSample = {
      at: 0,
      handId: "h",
      actionHandId: null,
      outcomeHandId: "h",
      mode: "NORMAL",
      phase: "SHOWDOWN",
      reduced: false,
      visibility: "visible",
      kind: "mutation",
      showdown: true,
    };
    expect(
      timelineViolations([sample, { ...sample, at: 200, outcomeHandId: null, showdown: false }]),
    ).toHaveLength(2);
    expect(
      timelineViolations([sample, { ...sample, at: 1200, outcomeHandId: null, showdown: false }]),
    ).toEqual([]);
    expect(validGateStats({ expected: 0, skipped: 0, unexpected: 0, flaky: 0 }, 8)).toBe(false);
    expect(validGateStats({ expected: 8, skipped: 1, unexpected: 0, flaky: 0 }, 8)).toBe(false);
    expect(validGateStats({ expected: 8, skipped: 0, unexpected: 0, flaky: 1 }, 8)).toBe(false);
    expect(validGateStats({ expected: 8, skipped: 0, unexpected: 0, flaky: 0 }, 8)).toBe(true);
  });
});
