import { describe, expect, it } from "vitest";
import { ServerClock, estimatedServerNow, submissionTimeRemaining } from "./server-clock";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("server clock under weak networks", () => {
  it.each([50, 100, 300, 500])(
    "calibrates %ims RTT without optimistic submission time under jitter/asymmetry",
    (rtt) => {
      let now = 100;
      const clock = new ServerClock(() => now);
      const offset = 1_800_000_000_000;
      const deadline = offset + 30_000;
      for (const [up, down, processing] of [
        [rtt / 2, rtt / 2, 0],
        [rtt * 0.8, rtt * 0.4, 35],
        [rtt * 0.2, rtt * 1.5, 60],
        [rtt / 2, rtt / 2, 0],
      ]) {
        const sent = now;
        now += up! + down! + processing!;
        const anchor = clock.synchronize({
          requestId,
          clientSentAt: sent,
          serverReceivedAt: offset + sent + up!,
          serverSentAt: offset + sent + up! + processing!,
        })!;
        expect(anchor.roundTripMs).not.toBeNull();
        expect(submissionTimeRemaining(deadline, anchor, now)).toBeLessThanOrEqual(
          deadline - (offset + now),
        );
        now += 5_000;
      }
    },
  );

  it("subtracts server queue time and survives wall clock jumps, delayed messages and render/remount time", () => {
    let now = 1_000;
    const clock = new ServerClock(() => now);
    now = 1_600;
    const synced = clock.synchronize({
      requestId,
      clientSentAt: 1_000,
      serverReceivedAt: 20_100,
      serverSentAt: 20_500,
    })!;
    expect(synced.roundTripMs).toBe(200);
    expect(estimatedServerNow(synced, now)).toBe(20_600);
    now = 6_600;
    const delayed = clock.observe(20_510);
    expect(estimatedServerNow(delayed, now)).toBe(25_600);
    now = 8_600; // component mounts two seconds after receipt
    expect(submissionTimeRemaining(30_000, delayed, now)).toBe(2_300);
    expect(submissionTimeRemaining(30_000, delayed, now + 10_000)).toBe(0);
    expect(submissionTimeRemaining(null, delayed, now + 10_000)).toBeNull();
  });

  it("does not regress after a lower offset sample; an actual deadline extension restores time", () => {
    let now = 500;
    const clock = new ServerClock(() => now);
    const first = clock.synchronize({
      requestId,
      clientSentAt: 0,
      serverReceivedAt: 10_250,
      serverSentAt: 10_250,
    })!;
    const before = submissionTimeRemaining(20_000, first, now)!;
    now = 1_000;
    const next = clock.synchronize({
      requestId,
      clientSentAt: 500,
      serverReceivedAt: 10_650,
      serverSentAt: 10_650,
    })!;
    expect(estimatedServerNow(next, now)).toBeGreaterThanOrEqual(estimatedServerNow(first, now));
    expect(submissionTimeRemaining(20_000, next, now)).toBeLessThanOrEqual(before - 500);
    expect(submissionTimeRemaining(50_000, next, now)).toBeGreaterThan(before);
  });

  it("rejects impossible/expired samples without poisoning calibration", () => {
    const clock = new ServerClock(() => 100);
    const sample = { requestId, clientSentAt: 0, serverReceivedAt: 10_000, serverSentAt: 10_100 };
    expect(clock.synchronize({ ...sample, clientSentAt: 200 })).toBeNull();
    expect(clock.synchronize({ ...sample, serverSentAt: 10_101 })).toBeNull();
    expect(clock.synchronize(sample, 10_001)).toBeNull();
    expect(clock.observe(10_000).roundTripMs).toBeNull();
    clock.synchronize({ ...sample, serverSentAt: 10_000 });
    clock.reset();
    expect(clock.observe(100).roundTripMs).toBeNull();
  });
});
