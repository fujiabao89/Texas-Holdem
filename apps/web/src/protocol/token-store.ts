export type TokenClearReason = "AUTH_FAILED" | "INVITE_EXPIRED" | "CLOSED" | "LEAVE_SUCCEEDED";

const storagePrefix = "texas-holdem:player-token:";

/** Current-tab credential storage; tokens are never written to durable browser stores. */
export class PlayerTokenStore {
  private readonly memory = new Map<string, string>();

  constructor(private readonly storage: Storage | undefined = browserSessionStorage()) {}

  save(roomId: string, playerToken: string): void {
    this.memory.set(roomId, playerToken);
    this.storage?.setItem(storageKey(roomId), playerToken);
  }

  get(roomId: string): string | null {
    const inMemory = this.memory.get(roomId);
    if (inMemory !== undefined) return inMemory;
    const stored = this.storage?.getItem(storageKey(roomId)) ?? null;
    if (stored !== null) this.memory.set(roomId, stored);
    return stored;
  }

  clear(roomId: string, _reason: TokenClearReason): void {
    this.memory.delete(roomId);
    this.storage?.removeItem(storageKey(roomId));
  }
}

function storageKey(roomId: string): string {
  return `${storagePrefix}${roomId}`;
}

function browserSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage;
}
