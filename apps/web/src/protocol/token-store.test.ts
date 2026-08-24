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
});
