import { describe, it, expect } from "vitest";
import {
  validateActionTimerConfig,
  initialTimeBankState,
  consumeTimeBank,
  resetTimeBankOpportunity,
  DEFAULT_ACTION_TIME,
  DEFAULT_TIME_BANK,
} from "./action-timer";

describe("validateActionTimerConfig", () => {
  it("接受合法有限档位与默认值", () => {
    expect(() => validateActionTimerConfig({ actionTime: 15, timeBank: 30 })).not.toThrow();
    expect(() =>
      validateActionTimerConfig({ actionTime: DEFAULT_ACTION_TIME, timeBank: DEFAULT_TIME_BANK }),
    ).not.toThrow();
    expect(() => validateActionTimerConfig({ actionTime: 60, timeBank: 120 })).not.toThrow();
  });

  it("拒绝非法 actionTime / timeBank 档位", () => {
    expect(() => validateActionTimerConfig({ actionTime: 25 as never, timeBank: 60 })).toThrow();
    expect(() => validateActionTimerConfig({ actionTime: 30, timeBank: 45 as never })).toThrow();
    expect(() => validateActionTimerConfig({ actionTime: 5 as never, timeBank: 0 })).toThrow();
  });

  it("UNLIMITED 时 timeBank 必须为 0", () => {
    expect(() => validateActionTimerConfig({ actionTime: "UNLIMITED", timeBank: 0 })).not.toThrow();
    expect(() => validateActionTimerConfig({ actionTime: "UNLIMITED", timeBank: 30 })).toThrow();
    expect(() => validateActionTimerConfig({ actionTime: "UNLIMITED", timeBank: 60 })).toThrow();
  });
});

describe("consumeTimeBank", () => {
  it("单次最多扣减 30 秒，且每个行动机会最多成功一次", () => {
    const used = consumeTimeBank(initialTimeBankState(60))!;
    expect(used.secondsRemaining).toBe(30);
    expect(used.usedThisOpportunity).toBe(true);
    // 同一机会第二次使用失败。
    expect(consumeTimeBank(used)).toBeNull();
  });

  it("余额不足 30 秒时扣减余量；用尽后不可再使用", () => {
    const used = consumeTimeBank({ secondsRemaining: 20, usedThisOpportunity: false })!;
    expect(used.secondsRemaining).toBe(0);
    expect(consumeTimeBank(used)).toBeNull();
    // 余额 0 直接不可用。
    expect(consumeTimeBank(initialTimeBankState(0))).toBeNull();
  });

  it("新行动机会复位 usedThisOpportunity 标记并保留余额", () => {
    const used = consumeTimeBank(initialTimeBankState(60))!;
    const next = resetTimeBankOpportunity(used);
    expect(next.secondsRemaining).toBe(30);
    expect(next.usedThisOpportunity).toBe(false);
    expect(consumeTimeBank(next)!.secondsRemaining).toBe(0);
  });
});
