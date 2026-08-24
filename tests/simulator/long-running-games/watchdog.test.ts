import { describe, expect, it } from "vitest";
import {
  createWatchdog,
  DEFAULT_WATCHDOG_THRESHOLDS,
  WatchdogFailure,
} from "./watchdog";
import type { WatchdogThresholds } from "./watchdog";

describe("Watchdog 默认阈值（docs/06 §5 工程基线）", () => {
  it("默认阈值为 50,000 action / 30,000ms / 每手 1,000 次转移", () => {
    expect(DEFAULT_WATCHDOG_THRESHOLDS).toEqual({
      maxActionsPerTournament: 50_000,
      maxElapsedMsPerTournament: 30_000,
      maxTransitionsPerHand: 1_000,
    });
  });
});

describe("Watchdog 越界检测（假时钟，不用 sleep）", () => {
  const tiny: WatchdogThresholds = {
    maxActionsPerTournament: 3,
    maxElapsedMsPerTournament: 1_000,
    maxTransitionsPerHand: 5,
  };

  it("Action 数越界按 action-limit 失败", () => {
    const watchdog = createWatchdog(tiny);
    for (let i = 0; i < 3; i++) {
      watchdog.noteAction();
      watchdog.noteTransition();
      expect(() => watchdog.check()).not.toThrow();
    }
    watchdog.noteAction();
    expect(() => watchdog.check()).toThrow(WatchdogFailure);
    try {
      watchdog.check();
    } catch (error) {
      expect((error as WatchdogFailure).breach).toBe("action-limit");
    }
  });

  it("进程时间越界按 time-limit 失败（注入时钟推进）", () => {
    let clock = 0;
    const watchdog = createWatchdog(
      { ...tiny, maxElapsedMsPerTournament: 100 },
      () => clock,
    );
    watchdog.noteTransition();
    expect(() => watchdog.check()).not.toThrow();
    clock = 101;
    try {
      watchdog.check();
      expect.unreachable("应抛出 WatchdogFailure");
    } catch (error) {
      expect((error as WatchdogFailure).breach).toBe("time-limit");
    }
  });

  it("连续状态转移未完成一手牌按 hand-stuck 失败；手完成后重置", () => {
    const watchdog = createWatchdog({ ...tiny, maxTransitionsPerHand: 4 });
    for (let i = 0; i < 4; i++) {
      watchdog.noteTransition();
      expect(() => watchdog.check()).not.toThrow();
    }
    watchdog.noteTransition();
    try {
      watchdog.check();
      expect.unreachable("应抛出 WatchdogFailure");
    } catch (error) {
      expect((error as WatchdogFailure).breach).toBe("hand-stuck");
    }
    // 完成一手后计数重置，不再越界。
    watchdog.noteHandCompleted();
    watchdog.noteTransition();
    expect(() => watchdog.check()).not.toThrow();
  });
});
