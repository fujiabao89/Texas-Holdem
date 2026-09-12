/**
 * HTTP 幂等存储（docs/02-protocol-spec.md §4.2、docs/04-game-server-architecture.md §10.2）。
 *
 * 作用域 = 身份（受保护接口为 playerId，创建/加入为 source IP）+ endpoint + key。
 * 相同 Payload 重试返回原结果；Key 相同而 Payload 不同返回 `IDEMPOTENCY_KEY_REUSE`。
 *
 * 并发安全：同 key 的第二个请求在首个请求执行期间会等待其完成（in-flight 门闩），
 * 然后按首个请求的缓存结果裁决（重放/冲突），不会并发产生两个副作用（如两个房间或两个身份）。
 * 执行失败不缓存结果：后续同 key 请求按重试策略重新执行。
 */

import { createHash } from "node:crypto";

export interface IdempotencyEntry {
  readonly payloadHash: string;
  readonly statusCode: number;
  readonly body: unknown;
  readonly ownerRoomId?: string;
}

/** 创建/加入只有执行完成时才知道归属房间；归属为服务器内部元数据。 */
export interface IdempotencyResult {
  readonly statusCode: number;
  readonly body: unknown;
  readonly ownerRoomId?: string;
}

interface InFlightExecution {
  readonly ownerRoomId?: string;
  readonly done: Promise<IdempotencyEntry | undefined>;
  cacheAllowed: boolean;
}

export type IdempotencyOutcome =
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "conflict" }
  | { kind: "executed"; statusCode: number; body: unknown };

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly keysByRoom = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, InFlightExecution>();
  private isRoomResident: (roomId: string) => boolean = () => true;
  private cacheGeneration: object = {};

  /** 应用装配时总会绑定（包括外部注入的 store），不持有无界的已关闭 Room ID 集合。 */
  bindRoomResidency(isRoomResident: (roomId: string) => boolean): void {
    this.isRoomResident = isRoomResident;
    for (const [key, entry] of this.entries) {
      if (entry.ownerRoomId !== undefined && !isRoomResident(entry.ownerRoomId))
        this.deleteEntry(key);
    }
  }

  /** 驻留期内不做 TTL/LRU；Room 关闭卸载时精确回收其账本。 */
  releaseRoom(roomId: string): void {
    for (const key of this.keysByRoom.get(roomId) ?? []) this.entries.delete(key);
    this.keysByRoom.delete(roomId);
    for (const pending of this.inFlight.values()) {
      if (pending.ownerRoomId === roomId) pending.cacheAllowed = false;
    }
  }

  /** 关停清理不拆除正在执行的门闩；旧执行完成后也不能重新填充已清空缓存。 */
  clear(): void {
    this.cacheGeneration = {};
    this.entries.clear();
    this.keysByRoom.clear();
    for (const pending of this.inFlight.values()) pending.cacheAllowed = false;
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(key: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(key);
    if (entry?.ownerRoomId !== undefined && !this.isRoomResident(entry.ownerRoomId)) {
      this.deleteEntry(key);
      return undefined;
    }
    return entry;
  }

  store(key: string, entry: IdempotencyEntry): void {
    this.deleteEntry(key);
    if (entry.ownerRoomId !== undefined && !this.isRoomResident(entry.ownerRoomId)) return;
    this.entries.set(key, entry);
    if (entry.ownerRoomId !== undefined) {
      const keys = this.keysByRoom.get(entry.ownerRoomId) ?? new Set<string>();
      keys.add(key);
      this.keysByRoom.set(entry.ownerRoomId, keys);
    }
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.ownerRoomId !== undefined) {
      const keys = this.keysByRoom.get(entry.ownerRoomId);
      keys?.delete(key);
      if (keys?.size === 0) this.keysByRoom.delete(entry.ownerRoomId);
    }
    this.entries.delete(key);
  }

  /**
   * 幂等执行：缓存命中则重放/冲突；同 key 已有 in-flight 请求则等待其完成后裁决；
   * 否则保留 key 并执行，成功后才缓存结果。
   */
  async run(
    key: string,
    payloadHash: string,
    execute: () => Promise<IdempotencyResult>,
    ownerRoomId?: string,
  ): Promise<IdempotencyOutcome> {
    return this.runWithinGeneration(
      key,
      payloadHash,
      execute,
      ownerRoomId,
      this.cacheGeneration,
      true,
    );
  }

  private async runWithinGeneration(
    key: string,
    payloadHash: string,
    execute: () => Promise<IdempotencyResult>,
    ownerRoomId: string | undefined,
    generation: object,
    cacheAllowed: boolean,
  ): Promise<IdempotencyOutcome> {
    const cached = this.lookup(key);
    if (cached !== undefined) {
      return cached.payloadHash === payloadHash
        ? { kind: "replay", statusCode: cached.statusCode, body: cached.body }
        : { kind: "conflict" };
    }
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) {
      // 等待者持有原执行的结果，而不是重新查可能已在关房时移除的缓存。
      // 这样关闭/clear 期间同 key 请求仍只执行一次，临时结果随等待者释放。
      const after = await inFlight.done;
      if (after === undefined) {
        // 原请求失败未缓存结果：当前请求按重试语义重新执行。
        return this.runWithinGeneration(
          key,
          payloadHash,
          execute,
          ownerRoomId,
          generation,
          cacheAllowed && inFlight.cacheAllowed,
        );
      }
      return after.payloadHash === payloadHash
        ? { kind: "replay", statusCode: after.statusCode, body: after.body }
        : { kind: "conflict" };
    }
    let release!: (entry: IdempotencyEntry | undefined) => void;
    const gate = new Promise<IdempotencyEntry | undefined>((resolve) => {
      release = resolve;
    });
    const pending: InFlightExecution = { ownerRoomId, done: gate, cacheAllowed };
    this.inFlight.set(key, pending);
    let entry: IdempotencyEntry | undefined;
    try {
      const result = await execute();
      entry = {
        payloadHash,
        statusCode: result.statusCode,
        body: result.body,
        ownerRoomId: ownerRoomId ?? result.ownerRoomId,
      };
      if (pending.cacheAllowed && generation === this.cacheGeneration) this.store(key, entry);
      return { kind: "executed", statusCode: result.statusCode, body: result.body };
    } finally {
      this.inFlight.delete(key);
      release(entry);
    }
  }
}

/** 稳定 Payload 摘要（SHA-256 hex）。`undefined` 请求体（无 body/无 Content-Type）归一化为稳定值，避免 update() 抛 TypeError。 */
export function hashPayload(payload: unknown): string {
  const serialized = payload === undefined ? "undefined" : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}
