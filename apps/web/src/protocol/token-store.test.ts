import { describe, expect, it } from "vitest";

import { PlayerTokenStore } from "./token-store";

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class ThrowingStorage extends FakeStorage {
  override setItem(): void { throw new Error("storage denied"); }
  override getItem(): string | null { throw new Error("storage denied"); }
  override removeItem(): void { throw new Error("storage denied"); }
}

describe("PlayerTokenStore", () => {
  it("isolates tokens by room in memory and sessionStorage only", () => {
    const session = new FakeStorage();
    const store = new PlayerTokenStore(session);
    store.save("room-1", "token-one");
    store.save("room-2", "token-two");
    expect(store.get("room-1")).toBe("token-one");
    expect(store.get("room-2")).toBe("token-two");
    expect([...session.values.keys()]).toEqual(["texas-holdem:player-token:room-1", "texas-holdem:player-token:room-2"]);
  });

  it.each(["AUTH_FAILED", "INVITE_EXPIRED", "CLOSED", "LEAVE_SUCCEEDED"] as const)("clears token for %s", (reason) => {
    const store = new PlayerTokenStore(new FakeStorage());
    store.save("room-1", "token-one");
    store.clear("room-1", reason);
    expect(store.get("room-1")).toBeNull();
  });

  it("falls back to memory when sessionStorage is unavailable", () => {
    const store = new PlayerTokenStore(new ThrowingStorage());
    store.save("room-1", "token-one", "player-1");
    expect(store.get("room-1")).toBe("token-one");
    expect(store.getPlayerId("room-1")).toBe("player-1");
    expect(() => store.clear("room-1", "CLOSED")).not.toThrow();
  });

  it("restores and clears a session only from a second same-tab store", () => {
    const storage = new FakeStorage();
    new PlayerTokenStore(storage).save("room-1", "token-one", "player-1");
    const restored = new PlayerTokenStore(storage);
    expect(restored.get("room-1")).toBe("token-one");
    expect(restored.getPlayerId("room-1")).toBe("player-1");
    restored.clear("room-1", "AUTH_FAILED");
    expect(new PlayerTokenStore(storage).get("room-1")).toBeNull();
  });
});
