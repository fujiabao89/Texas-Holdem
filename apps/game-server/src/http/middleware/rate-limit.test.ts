import { describe, expect, it } from "vitest";
import { createRateLimiter, parseRateLimitProfile } from "./rate-limit";

describe("parseRateLimitProfile", () => {
  it("缺省与 default 均返回 default", () => {
    expect(parseRateLimitProfile({})).toBe("default");
    expect(parseRateLimitProfile({ GAME_SERVER_RATE_LIMIT_PROFILE: "default" })).toBe("default");
  });

  it("load-test 仅允许非 production 环境", () => {
    expect(
      parseRateLimitProfile({ GAME_SERVER_RATE_LIMIT_PROFILE: "load-test", NODE_ENV: "test" }),
    ).toBe("load-test");
    expect(() =>
      parseRateLimitProfile({ GAME_SERVER_RATE_LIMIT_PROFILE: "load-test", NODE_ENV: "production" }),
    ).toThrow(/forbidden/i);
  });

  it("未知取值拒绝（防误配静默回退）", () => {
    expect(() => parseRateLimitProfile({ GAME_SERVER_RATE_LIMIT_PROFILE: "hax" })).toThrow();
  });
});

describe("createRateLimiter profile 额度", () => {
  it("default 档：创建 5/min 起即限流（第六次拒绝）", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(() => now, "default");
    for (let i = 0; i < 5; i++) {
      expect(limiter.checkCreateRoom("1.2.3.4").allowed).toBe(true);
    }
    // 分钟桶耗尽（burst=5），即使时间推进 1s 也不回填满一个新令牌（refill 5/60≈0.083/s）。
    now += 1000;
    expect(limiter.checkCreateRoom("1.2.3.4").allowed).toBe(false);
  });

  it("load-test 档：同一 IP 可在窗口内高频建房（仍保留有界上限）", () => {
    let now = 2_000_000;
    const limiter = createRateLimiter(() => now, "load-test");
    let allowed = 0;
    for (let i = 0; i < 500; i++) {
      now += 1;
      if (limiter.checkCreateRoom("1.2.3.4").allowed) allowed += 1;
    }
    // burst=600：前 500 次全部放行。
    expect(allowed).toBe(500);
  });

  it("load-test join 每 IP 可容纳整桌加入", () => {
    const limiter = createRateLimiter(() => 3_000_000, "load-test");
    for (let i = 0; i < 100; i++) {
      expect(limiter.checkJoinByIp("1.2.3.4").allowed).toBe(true);
    }
  });
});
