export type TokenClearReason = "AUTH_FAILED" | "INVITE_EXPIRED" | "CLOSED" | "LEAVE_SUCCEEDED";

const storagePrefix = "texas-holdem:player-token:";
const identityPrefix = "texas-holdem:player-id:";

/** Current-tab credential storage; tokens are never written to durable browser stores. */
export class PlayerTokenStore {
  private readonly memory = new Map<string, string>();
  private readonly playerIds = new Map<string, string>();
  private storage: Storage | undefined;

  constructor(storage: Storage | undefined = browserSessionStorage()) {
    this.storage = storage;
  }

  save(roomId: string, playerToken: string, playerId?: string): void {
    this.memory.set(roomId, playerToken);
    if (playerId !== undefined) this.playerIds.set(roomId, playerId);
    try {
      this.storage?.setItem(storageKey(roomId), playerToken);
      if (playerId !== undefined) this.storage?.setItem(identityKey(roomId), playerId);
    } catch {
      this.storage = undefined;
    }
  }

  getPlayerId(roomId: string): string | null {
    const inMemory = this.playerIds.get(roomId);
    if (inMemory !== undefined) return inMemory;
    try {
      const stored = this.storage?.getItem(identityKey(roomId)) ?? null;
      if (stored !== null) this.playerIds.set(roomId, stored);
      return stored;
    } catch {
      this.storage = undefined;
      return null;
    }
  }

  get(roomId: string): string | null {
    const inMemory = this.memory.get(roomId);
    if (inMemory !== undefined) return inMemory;
    let stored: string | null = null;
    try {
      stored = this.storage?.getItem(storageKey(roomId)) ?? null;
    } catch {
      this.storage = undefined;
    }
    if (stored !== null) this.memory.set(roomId, stored);
    return stored;
  }

  clear(roomId: string, _reason: TokenClearReason): void {
    this.memory.delete(roomId);
    this.playerIds.delete(roomId);
    try {
      this.storage?.removeItem(storageKey(roomId));
      this.storage?.removeItem(identityKey(roomId));
    } catch {
      this.storage = undefined;
    }
  }
}

function storageKey(roomId: string): string {
  return `${storagePrefix}${roomId}`;
}
function identityKey(roomId: string): string { return `${identityPrefix}${roomId}`; }

function browserSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
