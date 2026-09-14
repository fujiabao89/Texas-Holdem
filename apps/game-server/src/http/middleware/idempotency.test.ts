import { describe, expect, it, vi } from "vitest";
import { IdempotencyStore, type IdempotencyResult } from "./idempotency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("IdempotencyStore Room lifecycle", () => {
  it("replays resident Room results and rejects changed payloads without executing again", async () => {
    const store = new IdempotencyStore();
    const execute = vi.fn(async () => ({ statusCode: 200, body: { tournamentId: "first-round" } }));
    store.bindRoomResidency(() => true);
    await store.run("start-key", "payload", execute, "room-a");
    // A later round in the same resident Room must not evict an old requestId.
    const replay = await store.run("start-key", "payload", execute, "room-a");
    expect(replay).toEqual({
      kind: "replay",
      statusCode: 200,
      body: { tournamentId: "first-round" },
    });
    expect(await store.run("start-key", "different", execute, "room-a")).toEqual({
      kind: "conflict",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("releaseRoom removes only that Room's exact ownership, including private create/join responses", () => {
    const store = new IdempotencyStore();
    const entry = { payloadHash: "hash", statusCode: 200, body: { playerToken: "private-token" } };
    store.store("create:unrelated-name", { ...entry, ownerRoomId: "room-1" });
    store.store("join:unrelated-name", { ...entry, ownerRoomId: "room-1" });
    store.store("room-1-in-key-but-other-owner", { ...entry, ownerRoomId: "room-10" });
    store.releaseRoom("room-1");
    expect(store.lookup("create:unrelated-name")).toBeUndefined();
    expect(store.lookup("join:unrelated-name")).toBeUndefined();
    expect(store.lookup("room-1-in-key-but-other-owner")).toMatchObject({ ownerRoomId: "room-10" });
    expect(store.size).toBe(1);
    store.releaseRoom("room-1");
    expect(store.size).toBe(1);
  });

  it("closing during an in-flight command preserves the shared result without resurrecting its cache", async () => {
    const store = new IdempotencyStore();
    const completion = deferred<IdempotencyResult>();
    const execute = vi.fn(() => completion.promise);
    const first = store.run("key", "hash", execute, "room-a");
    const second = store.run("key", "hash", execute, "room-a");
    const conflicting = store.run("key", "different", execute, "room-a");
    store.releaseRoom("room-a");
    completion.resolve({ statusCode: 200, body: { finished: true } });
    expect(await first).toMatchObject({ kind: "executed" });
    expect(await second).toEqual({ kind: "replay", statusCode: 200, body: { finished: true } });
    expect(await conflicting).toEqual({ kind: "conflict" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.lookup("key")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("a create/join result discovered after Room closure is not retained", async () => {
    const store = new IdempotencyStore();
    const resident = new Set(["room-created"]);
    store.bindRoomResidency((roomId) => resident.has(roomId));
    const completion = deferred<IdempotencyResult>();
    const execute = vi.fn(() => completion.promise);
    const first = store.run("create-key", "hash", execute);
    const duplicate = store.run("create-key", "hash", execute);
    resident.delete("room-created");
    store.releaseRoom("room-created");
    completion.resolve({
      statusCode: 200,
      body: { playerToken: "private-token" },
      ownerRoomId: "room-created",
    });
    await first;
    expect(await duplicate).toMatchObject({ kind: "replay" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("clear does not remove in-flight gates or allow their completion to refill the cache", async () => {
    const store = new IdempotencyStore();
    const completion = deferred<IdempotencyResult>();
    const execute = vi.fn(() => completion.promise);
    const first = store.run("key", "hash", execute);
    store.clear();
    const duplicate = store.run("key", "hash", execute);
    completion.resolve({ statusCode: 200, body: "result" });
    await first;
    expect(await duplicate).toMatchObject({ kind: "replay" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("normal failed attempts remain retryable while a retry queued before clear cannot refill old cache", async () => {
    const store = new IdempotencyStore();
    const failed = deferred<IdempotencyResult>();
    const first = store.run("key", "hash", () => failed.promise);
    const failure = expect(first).rejects.toThrow("write failed");
    const retryExecute = vi.fn(async () => ({ statusCode: 200, body: "retried" }));
    const queued = store.run("key", "hash", retryExecute);
    store.clear();
    failed.reject(new Error("write failed"));
    await failure;
    expect(await queued).toEqual({ kind: "executed", statusCode: 200, body: "retried" });
    expect(retryExecute).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    await store.run("key", "hash", retryExecute);
    expect(store.size).toBe(1);
  });

  it("binding liveness to an injected store drops stale owners and completion checks it again", async () => {
    const store = new IdempotencyStore();
    store.store("stale", {
      payloadHash: "hash",
      statusCode: 200,
      body: "old",
      ownerRoomId: "closed",
    });
    store.bindRoomResidency((roomId) => roomId === "live");
    expect(store.lookup("stale")).toBeUndefined();
    await store.run("unknown", "hash", async () => ({
      statusCode: 200,
      body: "new",
      ownerRoomId: "closed",
    }));
    expect(store.size).toBe(0);
    await store.run("live", "hash", async () => ({ statusCode: 200, body: "new" }), "live");
    expect(store.size).toBe(1);
  });

  it("replacing a cache key updates its Room index and explicit owner takes precedence", async () => {
    const store = new IdempotencyStore();
    const entry = { payloadHash: "hash", statusCode: 200, body: "response" };
    store.store("key", { ...entry, ownerRoomId: "old" });
    store.store("key", { ...entry, ownerRoomId: "new" });
    store.releaseRoom("old");
    expect(store.lookup("key")).toMatchObject({ ownerRoomId: "new" });
    await store.run(
      "explicit",
      "hash",
      async () => ({ statusCode: 200, body: "response", ownerRoomId: "wrong" }),
      "new",
    );
    store.releaseRoom("wrong");
    expect(store.lookup("explicit")).toMatchObject({ ownerRoomId: "new" });
    store.releaseRoom("new");
    expect(store.size).toBe(0);
  });
});
