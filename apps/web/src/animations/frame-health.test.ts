import { describe, expect, it } from "vitest";
import { FrameHealth } from "./frame-health";

describe("FrameHealth", () => {
  it("ignores a lone long frame, but degrades sustained pressure for the table session", () => {
    const health = new FrameHealth();
    let now = 0;
    health.sample(now);
    for (let index = 0; index < 24; index += 1) health.sample(now += index === 3 ? 120 : 16.7);
    expect(health.isDegraded()).toBe(false);
    for (let index = 0; index < 24; index += 1) health.sample(now += 50);
    expect(health.isDegraded()).toBe(true);
    health.resetWindow();
    expect(health.sample(now + 16)).toBe(true);
  });

  it("discards hidden-tab gaps and partial windows", () => {
    const health = new FrameHealth();
    for (let index = 0; index < 10; index += 1) health.sample(index * 100);
    health.resetWindow();
    for (let index = 0; index < 25; index += 1) health.sample(60_000 + index * 16.7);
    expect(health.isDegraded()).toBe(false);
  });
});
