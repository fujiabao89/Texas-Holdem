import { describe, it, expect } from "vitest";
import { createBackpressureLatch } from "./backpressure";

describe("createBackpressureLatch（§12.2 hard 暂停保持到 ok）", () => {
  it("hard 命中即暂停；soft 不解除；仅回落到 ok 才恢复", () => {
    const latch = createBackpressureLatch();
    expect(latch.isHardPaused()).toBe(false);

    latch.onLevel("hard");
    expect(latch.isHardPaused()).toBe(true);

    // 队列从 hard 回落到 soft（仍高于 soft 阈值）：保持暂停，不重启手。
    latch.onLevel("soft");
    expect(latch.isHardPaused()).toBe(true);

    // 回落到 ok（低于 soft）：解除暂停。
    latch.onLevel("ok");
    expect(latch.isHardPaused()).toBe(false);
  });

  it("从未 hard 时 soft 不暂停；ok 幂等", () => {
    const latch = createBackpressureLatch();
    latch.onLevel("soft");
    expect(latch.isHardPaused()).toBe(false); // 软降级本身不暂停手
    latch.onLevel("ok");
    expect(latch.isHardPaused()).toBe(false);
    latch.onLevel("ok");
    expect(latch.isHardPaused()).toBe(false);
  });
});
