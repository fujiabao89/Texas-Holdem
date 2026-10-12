import { createServer, createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

export interface NetworkProfile {
  readonly rttMs: number;
  readonly jitterMs: number;
  readonly seed: number;
}
export interface TransferSample {
  readonly direction: "up" | "down";
  readonly bytes: number;
  readonly scheduledMs: number;
  readonly elapsedMs: number;
}

/** TCP bytes remain unchanged and ordered. pauseReads stops reading the real upstream socket. */
export async function createNetworkProxy(upstreamPort: number) {
  let profile: NetworkProfile = { rttMs: 0, jitterMs: 0, seed: 62 };
  let state = 62;
  let offline = false;
  let paused = false;
  const pairs = new Set<{
    client: Socket;
    upstream: Socket;
    cancel: () => void;
    resumeUpstream: () => void;
  }>();
  const samples: TransferSample[] = [];
  const operations: { at: number; type: string; profile?: NetworkProfile }[] = [];
  const errors: string[] = [];
  const server = createServer((client) => {
    if (offline) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
    client.setNoDelay();
    upstream.setNoDelay();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let buffered = 0;
    let stopped = false;
    const pair = {
      client,
      upstream,
      resumeUpstream: (): void => {
        upstream.resume();
      },
      cancel: () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        client.destroy();
        upstream.destroy();
        pairs.delete(pair);
      },
    };
    pairs.add(pair);
    if (paused) upstream.pause();
    for (const [source, target, direction] of [
      [client, upstream, "up"],
      [upstream, client, "down"],
    ] as const) {
      let tail = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let blocked = false;
      const pending: { bytes: Buffer; arrived: number; due: number; scheduledMs: number }[] = [];
      const resume = () => {
        if (!stopped && !blocked && !(paused && source === upstream)) source.resume();
      };
      if (source === upstream) pair.resumeUpstream = resume;
      const pump = () => {
        if (stopped || blocked || timer !== null || pending.length === 0) return;
        // One timer per direction, always draining the head. Per-chunk timers
        // can reorder equal deadlines when fractional delays are rounded.
        timer = setTimeout(
          () => {
            timers.delete(timer!);
            timer = null;
            while (
              !stopped &&
              !blocked &&
              pending.length > 0 &&
              pending[0]!.due <= performance.now()
            ) {
              const item = pending.shift()!;
              buffered -= item.bytes.length;
              if (target.destroyed) {
                pair.cancel();
                return;
              }
              if (samples.length < 10_000)
                samples.push({
                  direction,
                  bytes: item.bytes.length,
                  scheduledMs: item.scheduledMs,
                  elapsedMs: performance.now() - item.arrived,
                });
              else if (!errors.includes("transfer sample limit exceeded"))
                errors.push("transfer sample limit exceeded");
              if (!target.write(item.bytes)) {
                blocked = true;
                source.pause();
                target.once("drain", () => {
                  blocked = false;
                  resume();
                  pump();
                });
              }
            }
            pump();
          },
          Math.max(0, Math.ceil(pending[0]!.due - performance.now())),
        );
        timers.add(timer);
      };
      source.on("data", (bytes: Buffer) => {
        const arrived = performance.now();
        // Seeded LCG controls jitter only; no protocol/identity or card data is parsed here.
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const jitter = ((state / 2 ** 32) * 2 - 1) * profile.jitterMs;
        const delay = Math.max(0, profile.rttMs / 2 + jitter);
        tail = Math.max(tail, arrived + delay);
        const scheduledMs = tail - arrived;
        buffered += bytes.length;
        if (buffered > 1024 * 1024) {
          errors.push("proxy delay queue exceeded 1MiB");
          pair.cancel();
          return;
        }
        pending.push({ bytes, arrived, due: tail, scheduledMs });
        pump();
      });
      source.on("error", () => pair.cancel());
      source.on("close", () => pair.cancel());
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy listen failed");
  return {
    port: address.port,
    samples,
    operations,
    errors,
    setProfile(value: NetworkProfile) {
      if (
        ![value.rttMs, value.jitterMs, value.seed].every(Number.isFinite) ||
        value.rttMs < 0 ||
        value.jitterMs < 0
      )
        throw new Error("invalid network profile");
      profile = value;
      state = value.seed >>> 0;
      operations.push({ at: performance.now(), type: "profile", profile });
    },
    disconnect() {
      offline = true;
      operations.push({ at: performance.now(), type: "offline" });
      for (const pair of [...pairs]) pair.cancel();
    },
    reconnect() {
      offline = false;
      operations.push({ at: performance.now(), type: "online" });
    },
    pauseReads() {
      paused = true;
      operations.push({ at: performance.now(), type: "pause-upstream-read" });
      for (const pair of pairs) pair.upstream.pause();
    },
    resumeReads() {
      paused = false;
      operations.push({ at: performance.now(), type: "resume-upstream-read" });
      for (const pair of pairs) pair.resumeUpstream();
    },
    connectionCount() {
      return pairs.size;
    },
    async close() {
      for (const pair of [...pairs]) pair.cancel();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export type NetworkProxy = Awaited<ReturnType<typeof createNetworkProxy>>;
