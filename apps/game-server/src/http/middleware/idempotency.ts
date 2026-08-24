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
}

export type IdempotencyOutcome =
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "conflict" }
  | { kind: "executed"; statusCode: number; body: unknown };

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();

  lookup(key: string): IdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  store(key: string, entry: IdempotencyEntry): void {
    this.entries.set(key, entry);
  }

  /**
   * 幂等执行：缓存命中则重放/冲突；同 key 已有 in-flight 请求则等待其完成后裁决；
   * 否则保留 key 并执行，成功后才缓存结果。
   */
  async run(key: string, payloadHash: string, execute: () => Promise<{ statusCode: number; body: unknown }>): Promise<IdempotencyOutcome> {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      return cached.payloadHash === payloadHash
        ? { kind: "replay", statusCode: cached.statusCode, body: cached.body }
        : { kind: "conflict" };
    }
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) {
      await inFlight;
      const after = this.entries.get(key);
      if (after === undefined) {
        // 原请求失败未缓存结果：当前请求按重试语义重新执行。
        return this.run(key, payloadHash, execute);
      }
      return after.payloadHash === payloadHash
        ? { kind: "replay", statusCode: after.statusCode, body: after.body }
        : { kind: "conflict" };
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inFlight.set(key, gate);
    try {
      const result = await execute();
      this.entries.set(key, { payloadHash, statusCode: result.statusCode, body: result.body });
      return { kind: "executed", statusCode: result.statusCode, body: result.body };
    } finally {
      this.inFlight.delete(key);
      release();
    }
  }
}

/** 稳定 Payload 摘要（SHA-256 hex）。`undefined` 请求体（无 body/无 Content-Type）归一化为稳定值，避免 update() 抛 TypeError。 */
export function hashPayload(payload: unknown): string {
  const serialized = payload === undefined ? "undefined" : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}
