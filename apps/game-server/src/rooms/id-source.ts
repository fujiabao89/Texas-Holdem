/**
 * 可注入的身份/随机/时钟来源（AGENTS.md §5、docs/04-game-server-architecture.md §3）。
 *
 * 生产实现使用 node:crypto CSPRNG 与系统时钟；测试注入可复现源。
 * 邀请码与 playerToken 的随机熵均由 `randomBytes` 提供。
 */

import { randomBytes, randomUUID } from "node:crypto";

export interface IdSource {
  readonly uuid: () => string;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly now: () => number;
}

export function createNodeIdSource(): IdSource {
  return {
    uuid: () => randomUUID(),
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    now: () => Date.now(),
  };
}
