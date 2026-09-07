import { describe, expect, it } from "vitest";

import {
  MAX_PLAYERS_PER_ROOM,
  MAX_ROOMS,
  MIN_PLAYERS_PER_ROOM,
  SCENARIO_SLO,
  SCENARIO_TARGETS,
  ScenarioPlanError,
  isScenarioName,
  resolvePlan,
} from "./scenarios";

describe("scenario targets（docs/06 §10.1 对齐）", () => {
  it("normal=100×10/30min；soak=50×10/4h；headroom=130×10/10min 且 releaseGate", () => {
    expect(SCENARIO_TARGETS.normal).toMatchObject({ rooms: 100, players: 10, durationMs: 1_800_000, releaseGate: true });
    expect(SCENARIO_TARGETS.soak).toMatchObject({ rooms: 50, players: 10, durationMs: 4 * 3_600_000, releaseGate: true });
    expect(SCENARIO_TARGETS.headroom).toMatchObject({ rooms: 130, players: 10, durationMs: 600_000, releaseGate: true });
  });

  it("burst=500 命令/1s 分 ≥50 Room；reconnect=500 重连/1min", () => {
    expect(SCENARIO_TARGETS.burst).toMatchObject({ kind: "burst", rooms: 50, opCount: 500, opWindowMs: 1_000 });
    expect(SCENARIO_TARGETS.reconnect).toMatchObject({ kind: "reconnect", rooms: 50, opCount: 500, opWindowMs: 60_000 });
  });

  it("smoke 非 releaseGate 且无 SLO；其余正式场景各有 SLO", () => {
    expect(SCENARIO_TARGETS.smoke.releaseGate).toBe(false);
    expect(SCENARIO_SLO.smoke).toEqual([]);
    for (const name of ["normal", "burst", "reconnect", "soak", "headroom"] as const) {
      expect(SCENARIO_SLO[name].length).toBeGreaterThan(0);
    }
  });

  it("所有场景 players 在 2–10、duration ≥1000", () => {
    for (const target of Object.values(SCENARIO_TARGETS)) {
      expect(target.players).toBeGreaterThanOrEqual(MIN_PLAYERS_PER_ROOM);
      expect(target.players).toBeLessThanOrEqual(MAX_PLAYERS_PER_ROOM);
      expect(target.durationMs).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe("scenario resolvePlan", () => {
  it("默认目标不标 reducedEvidence", () => {
    const plan = resolvePlan("smoke", {});
    expect(plan).toMatchObject({ name: "smoke", rooms: 2, players: 4, reducedEvidence: false });
  });

  it("下调任一维度即标 reducedEvidence（如实标注非 Release 结果）", () => {
    const plan = resolvePlan("normal", { rooms: 5, durationMs: 30_000 });
    expect(plan.rooms).toBe(5);
    expect(plan.reducedEvidence).toBe(true);
  });

  it("上调不算 reducedEvidence", () => {
    const plan = resolvePlan("smoke", { durationMs: 120_000 });
    expect(plan.reducedEvidence).toBe(false);
  });

  it("越界抛错：rooms 上限/下限、players、duration", () => {
    expect(() => resolvePlan("normal", { rooms: MAX_ROOMS + 1 })).toThrow(ScenarioPlanError);
    expect(() => resolvePlan("normal", { rooms: 0 })).toThrow(ScenarioPlanError);
    expect(() => resolvePlan("normal", { players: 1 })).toThrow(ScenarioPlanError);
    expect(() => resolvePlan("normal", { players: 11 })).toThrow(ScenarioPlanError);
    expect(() => resolvePlan("normal", { durationMs: 500 })).toThrow(ScenarioPlanError);
  });

  it("未知场景名抛错", () => {
    expect(() => resolvePlan("nope", {})).toThrow(/未知场景/);
    expect(isScenarioName("nope")).toBe(false);
    expect(isScenarioName("burst")).toBe(true);
  });
});
