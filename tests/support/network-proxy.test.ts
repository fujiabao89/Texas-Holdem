import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createNetworkProxy } from "./network-proxy";

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
