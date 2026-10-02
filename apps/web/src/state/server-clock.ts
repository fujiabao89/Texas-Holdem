import type { TimeSyncResultPayload } from "@texas-holdem/protocol";

export interface ServerClockAnchor {
  readonly serverTimeAtReceipt: number;
  readonly performanceNowAtReceipt: number;
  readonly roundTripMs: number | null;
  readonly safetyMarginMs: number;
}

/** Four-timestamp calibration; only display/submit UX, never game authority. */
export class ServerClock {
  private anchor: ServerClockAnchor | null = null;
  private offset: number | null = null;
  private jitter = 0;
  private latestRtt: number | null = null;
  private smoothedRtt: number | null = null;

  constructor(readonly now: () => number = () => performance.now()) {}

  reset(preserveEstimate = false): void {
    this.anchor =
      preserveEstimate && this.anchor !== null ? { ...this.anchor, roundTripMs: null } : null;
    this.offset = null;
    this.jitter = 0;
    this.latestRtt = null;
    this.smoothedRtt = null;
  }

  observe(serverTime: number, receivedAt = this.now()): ServerClockAnchor {
    const previousNow =
      this.anchor === null ? serverTime : estimatedServerNow(this.anchor, receivedAt);
    this.anchor = {
      serverTimeAtReceipt: Math.max(
        serverTime,
        previousNow,
        this.offset === null ? serverTime : receivedAt + this.offset,
      ),
      performanceNowAtReceipt: receivedAt,
      roundTripMs: this.smoothedRtt,
      safetyMarginMs: this.anchor?.safetyMarginMs ?? 0,
    };
    return this.anchor;
  }

  synchronize(sample: TimeSyncResultPayload, receivedAt = this.now()): ServerClockAnchor | null {
    const elapsed = receivedAt - sample.clientSentAt;
    const processing = sample.serverSentAt - sample.serverReceivedAt;
    if (elapsed < 0 || elapsed > 10_000 || processing < 0 || processing > elapsed) return null;
    const rtt = elapsed - processing;
    const sampleOffset =
      (sample.serverReceivedAt + sample.serverSentAt - sample.clientSentAt - receivedAt) / 2;
    this.offset = this.offset === null ? sampleOffset : this.offset * 0.8 + sampleOffset * 0.2;
    this.jitter =
      this.latestRtt === null ? 0 : this.jitter * 0.8 + Math.abs(rtt - this.latestRtt) * 0.2;
    this.latestRtt = rtt;
    this.smoothedRtt = this.smoothedRtt === null ? rtt : this.smoothedRtt * 0.8 + rtt * 0.2;
    const anchor = this.observe(sample.serverSentAt, receivedAt);
    this.anchor = {
      ...anchor,
      safetyMarginMs: Math.ceil(
        Math.max(50, rtt / 2, this.smoothedRtt / 2) +
          2 * this.jitter +
          Math.max(0, receivedAt + sampleOffset - anchor.serverTimeAtReceipt),
      ),
    };
    return this.anchor;
  }
}

export function estimatedServerNow(anchor: ServerClockAnchor, now: number): number {
  return anchor.serverTimeAtReceipt + Math.max(0, now - anchor.performanceNowAtReceipt);
}

export function submissionTimeRemaining(
  deadline: number | null,
  anchor: ServerClockAnchor,
  now: number,
): number | null {
  return deadline === null
    ? null
    : Math.max(0, deadline - estimatedServerNow(anchor, now) - anchor.safetyMarginMs);
}
