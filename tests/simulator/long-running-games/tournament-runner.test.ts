import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTournament } from "./tournament-runner";
import { CoverageStats } from "./stats";
import {
  SimulationFailure,
  formatFailureReport,
  serializeFailure,
  writeFailureArtifact,
} from "./failure";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tex-sim-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 忽略 elapsedMs 后的可重放比较视图。 */
function replayable(result: ReturnType<typeof runTournament>) {
  const { elapsedMs: _elapsed, ...rest } = result;
  return rest;
}

const tightActionLimit = {
  maxActionsPerTournament: 2,
  maxElapsedMsPerTournament: 60_000,
  maxTransitionsPerHand: 1_000,
};

describe("runTournament 端到端", () => {
  it(
    "完整跑到唯一 Champion，且不变量/事件序列检查全程通过",
    { timeout: 60_000 },
    () => {
      const result = runTournament(20260821);
      expect(result.champion).not.toBeNull();
      expect(result.hands.length).toBeGreaterThan(0);
      expect(result.actionsTaken).toBeGreaterThan(0);
      for (const hand of result.hands) {
        expect(hand.potCount).toBeGreaterThanOrEqual(1);
        expect(hand.playersAtStart).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it(
    "代理只提交合法动作：30 个不同 seed 全部无失败完成",
    { timeout: 120_000 },
    () => {
      for (let i = 0; i < 30; i++) {
        const result = runTournament(500_000 + i * 7);
        expect(result.champion).not.toBeNull();
      }
    },
  );

  it(
    "覆盖统计：80 个 seed 覆盖全部分层必需类别",
    { timeout: 180_000 },
    () => {
      const stats = new CoverageStats();
      for (let i = 0; i < 80; i++) {
        stats.recordTournament(runTournament(700_000 + i * 13));
      }
      expect(stats.missingCategories()).toEqual([]);
    },
  );
});

describe("强制 Blind Mode（Nightly 逐模式下限，docs/06 §5）", () => {
  it(
    "runTournament 以指定模式生成场景并完整跑完",
    { timeout: 60_000 },
    () => {
      for (const mode of ["fixed", "hands", "time"] as const) {
        const result = runTournament(606_060 + mode.length, { blindMode: mode });
        expect(result.scenario.blindMode).toBe(mode);
        expect(result.champion).not.toBeNull();
      }
    },
  );

  it("同 seed + 同强制模式结果完全一致（可重放）", () => {
    const a = runTournament(707_070, { blindMode: "time" });
    const b = runTournament(707_070, { blindMode: "time" });
    expect(replayable(b)).toEqual(replayable(a));
  });
});

describe("seed 重放（docs/06 §5：同一 seed 100% 重放）", () => {
  it(
    "同一 seed 两次运行产生完全一致的结果（场景/动作序列/手记录/冠军）",
    { timeout: 60_000 },
    () => {
      const first = runTournament(987_654_321);
      const second = runTournament(987_654_321);
      expect(replayable(second)).toEqual(replayable(first));
    },
  );

  it(
    "不同 seed 产生不同结果",
    { timeout: 60_000 },
    () => {
      const a = runTournament(111);
      const b = runTournament(222);
      expect(replayable(b)).not.toEqual(replayable(a));
    },
  );
});

describe("Watchdog 失败与现场保留", () => {
  it("阈值收紧后按 watchdog 类别失败，失败对象携带 seed/场景/轨迹/状态", () => {
    let failure: SimulationFailure | null = null;
    try {
      runTournament(31415926, { thresholds: tightActionLimit });
      expect.unreachable("应触发 watchdog 失败");
    } catch (error) {
      expect(error).toBeInstanceOf(SimulationFailure);
      failure = error as SimulationFailure;
    }
    expect(failure!.category).toBe("watchdog-action-limit");
    expect(failure!.seed).toBe(31415926);
    expect(failure!.scenario).not.toBeNull();
    expect(failure!.actions.length).toBeGreaterThan(0);
    expect(failure!.state).not.toBeNull();
    expect(failure!.replayCommand()).toBe("pnpm test:sim -- --seed 31415926 --games 1");
  });

  it("hand-stuck 阈值同样触发失败", () => {
    try {
      runTournament(27182818, {
        thresholds: { maxActionsPerTournament: 50_000, maxElapsedMsPerTournament: 60_000, maxTransitionsPerHand: 3 },
      });
      expect.unreachable("应触发 watchdog 失败");
    } catch (error) {
      expect((error as SimulationFailure).category).toBe("watchdog-hand-stuck");
    }
  });
});

describe("失败产物（docs/06 §5「输出」）", () => {
  it("serializeFailure 包含类别/seed/重放命令/场景/动作与统计摘要", () => {
    try {
      runTournament(1618033, { thresholds: tightActionLimit });
      expect.unreachable("应触发 watchdog 失败");
    } catch (error) {
      const failure = error as SimulationFailure;
      const serialized = serializeFailure(failure) as Record<string, unknown>;
      expect(serialized["category"]).toBe("watchdog-action-limit");
      expect(serialized["seed"]).toBe(1618033);
      expect(serialized["replayCommand"]).toBe("pnpm test:sim -- --seed 1618033 --games 1");
      expect(serialized["scenario"]).toEqual(failure.scenario);
      expect(Array.isArray(serialized["actions"])).toBe(true);
      expect(serialized["statsSummary"]).toBeNull();
      // JSON 可序列化（含冻结状态/事件）。
      expect(() => JSON.stringify(serialized)).not.toThrow();
    }
  });

  it("writeFailureArtifact 写入产物文件且内容可解析", () => {
    let failure: SimulationFailure;
    try {
      runTournament(11235813, { thresholds: tightActionLimit });
      throw new Error("不可达：应触发 watchdog 失败");
    } catch (error) {
      failure = error as SimulationFailure;
    }
    const dir = tempDir();
    const path = writeFailureArtifact(dir, failure);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed["category"]).toBe("watchdog-action-limit");
    expect(parsed["seed"]).toBe(11235813);
    expect(String(path)).toContain(dir);

    const report = formatFailureReport(failure);
    expect(report).toContain("RESULT: FAILED");
    expect(report).toContain("watchdog-action-limit");
    expect(report).toContain("seed=11235813");
    expect(report).toContain(failure.scenario!.label);
  });
});
