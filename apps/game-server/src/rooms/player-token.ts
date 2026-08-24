/**
 * playerToken 签发（docs/02-protocol-spec.md §5；docs/03-data-model.md §5.2）。
 *
 * - 至少 256-bit 密码学随机熵：`randomBytes(32)` 经 base64url 编码为 43 字符，
 *   满足协议 `PlayerTokenSchema`（min 43）。
 * - token 只在创建/加入 Room 的成功 HTTP 响应中交给本人；原值绝不落盘、不进日志，
 *   持久化只存 HMAC 摘要（见 infrastructure/persistence/player-token.ts）。
 * - 生成使用可注入随机源：生产为 node:crypto CSPRNG，测试为可复现源。
 */

import type { SecureRandomBytes } from "./invite-code";

export const PLAYER_TOKEN_BYTES = 32;

/** 生成一个 43 字符 base64url playerToken（32 字节 = 256 bit 熵）。 */
export function generatePlayerToken(randomBytes: SecureRandomBytes): string {
  return Buffer.from(randomBytes(PLAYER_TOKEN_BYTES)).toString("base64url");
}
