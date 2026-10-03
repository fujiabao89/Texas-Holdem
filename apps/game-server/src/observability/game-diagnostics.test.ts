import { describe, expect, it } from "vitest";
import { buildIdentity, createGameDiagnostics, type GameDiagnostic } from "./game-diagnostics";
import { createServerMetrics, N } from "./server-metrics";

describe("TEX-61 safe diagnostics and build identity", () => {
  it("exposes only validated version/SHA and never dumps an environment", () => {
    expect(
      buildIdentity({
        APP_VERSION: "1.2.3",
        DEPLOYMENT_SHA: "ABC123DEF",
        TOKEN_HMAC_SECRET: "private",
      }),
    ).toEqual({ version: "1.2.3", deploymentSha: "abc123def" });
    expect(
      buildIdentity({ APP_VERSION: "Bearer private-token", DEPLOYMENT_SHA: "private-token" }),
    ).toEqual({ version: "unknown", deploymentSha: null });
    expect(buildIdentity({})).toEqual({ version: "0.1.0", deploymentSha: null });
  });

  it("projects a closed field list even if a runtime object contains private payloads", () => {
    const metrics = createServerMetrics(),
      lines: string[] = [];
    const record = {
      event: "HAND_STARTED",
      trigger: "START",
      roomId: "r1",
      tournamentId: "t1",
      handId: "h1",
      playerId: null,
      eventSequence: "1",
      timestamp: 1000,
      playerToken: "DO_NOT_LOG_TOKEN",
      deck: "DO_NOT_LOG_DECK",
      holeCards: "DO_NOT_LOG_CARDS",
      error: new Error("DO_NOT_LOG_ERROR"),
    } as GameDiagnostic;
    createGameDiagnostics(metrics, buildIdentity({}), (line) => lines.push(line))(record);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "HAND_STARTED",
      handId: "h1",
      eventSequence: "1",
      version: "0.1.0",
      deploymentSha: null,
    });
    expect(lines.join("")).not.toContain("DO_NOT_LOG");
    expect(metrics.render()).not.toMatch(/roomId|playerId|tournamentId|handId/);
  });

  it("counts bounded reasons and observes actual timer/recovery delays even if logging fails", () => {
    const metrics = createServerMetrics();
    const diagnose = createGameDiagnostics(metrics, buildIdentity({}), () => {
      throw new Error("sink unavailable");
    });
    const base = {
      roomId: "r",
      tournamentId: "t",
      handId: "h",
      playerId: "p",
      eventSequence: "1",
      timestamp: 1,
    };
    diagnose({
      ...base,
      event: "AUTO_ACTION",
      trigger: "SYSTEM_TIMER_ACTION",
      action: "fold",
      delayMs: 123,
    });
    diagnose({ ...base, event: "RESYNC_REQUIRED", trigger: "bytes" });
    diagnose({ ...base, event: "SNAPSHOT_SENT", trigger: "BACKPRESSURE", delayMs: 456 });
    diagnose({ ...base, event: "SLOW_CONNECTION_CLOSED", trigger: "hard_bytes" });
    expect(metrics.countOf(N.autoActions, { action: "fold" })).toBe(1);
    expect(metrics.countOf(N.actionTimerDelaySeconds)).toBe(1);
    expect(metrics.countOf(N.resyncRequired, { trigger: "bytes" })).toBe(1);
    expect(metrics.countOf(N.snapshotsSent, { trigger: "BACKPRESSURE" })).toBe(1);
    expect(metrics.countOf(N.resyncRecoverySeconds)).toBe(1);
    expect(metrics.countOf(N.slowConnectionsClosed, { trigger: "hard_bytes" })).toBe(1);
    expect(metrics.render()).toContain("texas_resync_recovery_seconds_sum{} 0.456");
  });
});
