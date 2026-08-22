import { describe, expect, it } from "vitest";
import { createFakeClock } from "./fake-clock";

describe("createFakeClock", () => {
  it("advance 到期触发 timeout，且推进后 now 达到目标时间", () => {
    const clock = createFakeClock({ now: 1_000 });
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("a"), 100);
    clock.setTimeout(() => fired.push("b"), 300);

    clock.advance(150);
    expect(fired).toEqual(["a"]);
    expect(clock.now()).toBe(1_150);
    expect(clock.pendingTimers()).toBe(1);

    clock.advance(150);
    expect(fired).toEqual(["a", "b"]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("同一时刻按注册顺序执行", () => {
    const clock = createFakeClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(1), 50);
    clock.setTimeout(() => fired.push(2), 50);
    clock.setTimeout(() => fired.push(3), 50);

    clock.advance(50);
    expect(fired).toEqual([1, 2, 3]);
  });

  it("interval 按周期重复触发，clearInterval 后停止", () => {
    const clock = createFakeClock();
    let ticks = 0;
    const handle = clock.setInterval(() => ticks++, 10);

    clock.advance(35);
    expect(ticks).toBe(3);

    expect(clock.clearInterval(handle)).toBe(true);
    clock.advance(100);
    expect(ticks).toBe(3);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("clearTimeout 取消未到期任务", () => {
    const clock = createFakeClock();
    let fired = false;
    const handle = clock.setTimeout(() => (fired = true), 10);

    expect(clock.clearTimeout(handle)).toBe(true);
    expect(clock.clearTimeout(handle)).toBe(false);
    clock.advance(20);
    expect(fired).toBe(false);
  });

  it("回调中注册的新 timer 若落在同一窗口内也会按时间顺序触发", () => {
    const clock = createFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      fired.push("outer");
      clock.setTimeout(() => fired.push("inner"), 5);
    }, 10);

    clock.advance(20);
    expect(fired).toEqual(["outer", "inner"]);
  });

  it("dispose 清空全部 timer 且可断言无遗留", () => {
    const clock = createFakeClock();
    clock.setTimeout(() => undefined, 10);
    clock.setInterval(() => undefined, 10);

    expect(clock.pendingTimers()).toBe(2);
    expect(clock.dispose()).toBe(2);
    expect(clock.pendingTimers()).toBe(0);
    expect(clock.dispose()).toBe(0);
  });

  it("非法参数抛出明确错误", () => {
    const clock = createFakeClock();
    expect(() => clock.advance(-1)).toThrow(/非法推进量/);
    expect(() => clock.setTimeout(() => undefined, -5)).toThrow(/非法延迟/);
    expect(() => createFakeClock({ now: Number.NaN })).toThrow(/非法起始时间/);
  });

  it("纯同步可控：不推进则不触发", () => {
    const clock = createFakeClock();
    let fired = false;
    clock.setTimeout(() => (fired = true), 1);
    expect(fired).toBe(false);
    clock.advance(1);
    expect(fired).toBe(true);
  });
});
