import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createNetworkProxy } from "./network-proxy";

it("backpressures a real burst before the proxy's own delay queue reaches its hard bound", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  const proxy = await createNetworkProxy(address.port);
  proxy.setProfile({ rttMs: 100, jitterMs: 10, seed: 62 });
  const client = createConnection({ host: "127.0.0.1", port: proxy.port });
  const expected = Buffer.alloc(2 * 1024 * 1024, 0xa5);
  const chunks: Buffer[] = [];
  let total = 0;
  const received = new Promise<Buffer>((resolve) =>
    client.on("data", (bytes: Buffer) => {
      chunks.push(bytes);
      total += bytes.length;
      if (total === expected.length) resolve(Buffer.concat(chunks));
    }),
  );
  try {
    await once(client, "connect");
    client.write(expected);
    expect((await received).equals(expected)).toBe(true);
    expect(proxy.errors).toEqual([]);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("keeps fragmented real TCP bursts ordered under seeded jitter and equal deadlines", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  const proxy = await createNetworkProxy(address.port);
  proxy.setProfile({ rttMs: 300, jitterMs: 149, seed: 62 });
  const client = createConnection({ host: "127.0.0.1", port: proxy.port });
  client.setNoDelay();
  const chunks: Buffer[] = [];
  let total = 0;
  const received = new Promise<Buffer>((resolve) =>
    client.on("data", (bytes: Buffer) => {
      chunks.push(bytes);
      total += bytes.length;
      if (total >= 128) resolve(Buffer.concat(chunks));
    }),
  );
  try {
    await once(client, "connect");
    const expected = Buffer.from(Array.from({ length: 128 }, (_, index) => index));
    for (const byte of expected) {
      client.write(Buffer.from([byte]));
      await new Promise((resolve) => setTimeout(resolve, 1)); // Real packet fragmentation injection.
    }
    expect(await received).toEqual(expected);
    expect(proxy.samples.filter((sample) => sample.direction === "up").length).toBeGreaterThan(5);
    expect(proxy.errors).toEqual([]);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("TEX-62 forwards real TCP bytes in order, delays both directions and isolates disconnect", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  const proxy = await createNetworkProxy(address.port);
  proxy.setProfile({ rttMs: 50, jitterMs: 0, seed: 62 });
  const client = createConnection({ host: "127.0.0.1", port: proxy.port });
  try {
    await once(client, "connect");
    const received = once(client, "data");
    client.write("unchanged-WS-byte-stream");
    expect(String((await received)[0])).toBe("unchanged-WS-byte-stream");
    expect(proxy.samples.map((sample) => sample.direction)).toEqual(["up", "down"]);
    expect(proxy.samples.every((sample) => sample.elapsedMs >= 20)).toBe(true);
    proxy.pauseReads();
    expect(proxy.operations.at(-1)?.type).toBe("pause-upstream-read");
    proxy.resumeReads();
    const closed = once(client, "close");
    proxy.disconnect();
    await closed;
    expect(proxy.connectionCount()).toBe(0);
    expect(proxy.errors).toEqual([]);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
