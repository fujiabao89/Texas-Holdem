/**
 * HTTP 幂等存储（docs/02-protocol-spec.md §4.2、docs/04-game-server-architecture.md §10.2）。
 *
 * 作用域 = 身份（受保护接口为 playerId，创建/加入为 source IP）+ endpoint + key。
 * 相同 Payload 重试返回原结果；Key 相同而 Payload 不同返回 `IDEMPOTENCY_KEY_REUSE`。
 * 缓存驻留内存（Runtime 驻留期）；业务命令仍进入 Room 队列做执行时复核。
 */

import { createHash } from "node:crypto";

export interface IdempotencyEntry {
  readonly payloadHash: string;
  readonly statusCode: number;
  readonly body: unknown;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  lookup(key: string): IdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  store(key: string, entry: IdempotencyEntry): void {
    this.entries.set(key, entry);
  }
}

/** 稳定 Payload 摘要（SHA-256 hex）。`undefined` 请求体（无 body/无 Content-Type）归一化为稳定值，避免 update() 抛 TypeError。 */
export function hashPayload(payload: unknown): string {
  const serialized = payload === undefined ? "undefined" : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}
