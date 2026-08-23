import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * playerToken 凭证摘要（docs/03-data-model.md §5.2/§6）。
 *
 * - 原 token 永不落盘：数据库只存 HMAC-SHA-256 摘要（32 字节）与密钥版本号。
 * - HMAC 输入是明确编码的 `roomId || playerId || playerToken`（UTF-8，以 `:` 分隔；
 *   roomId/playerId 是不含冒号的 uuid 字符串，token 是服务端生成的无冒号高熵串，
 *   因此无拼接歧义）。
 * - HMAC 密钥只存服务端 Secret（环境注入），`keyId` 标识密钥版本用于轮换；
 *   轮换不得使未关闭 Room 的现有 token 意外失效（§5.2）。
 * - token 的 CSPRNG 生成与下发属控制面任务（TEX-19），本模块只负责摘要与校验。
 */

export const PLAYER_TOKEN_DIGEST_LENGTH = 32;

export interface PlayerTokenDigestInput {
  readonly roomId: string;
  readonly playerId: string;
  readonly token: string;
  readonly keyId: string;
  readonly secret: string | Buffer;
}

/** 计算 `room_players.token_digest`。 */
export function computePlayerTokenDigest(input: PlayerTokenDigestInput): Buffer {
  const hmac = createHmac("sha256", input.secret);
  hmac.update(`${input.roomId}:${input.playerId}:${input.token}`, "utf8");
  return hmac.digest();
}

/**
 * 常数时间比较两个摘要（校验 token 时使用，§5.2）。
 * 长度不一致时仍执行一次比较以保持时间行为稳定。
 */
export function playerTokenDigestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== PLAYER_TOKEN_DIGEST_LENGTH || b.length !== PLAYER_TOKEN_DIGEST_LENGTH) {
    // 用固定长度哑比较避免长度分支泄露信息，然后返回 false。
    timingSafeEqual(Buffer.alloc(PLAYER_TOKEN_DIGEST_LENGTH), Buffer.alloc(PLAYER_TOKEN_DIGEST_LENGTH));
    return false;
  }
  return timingSafeEqual(a, b);
}
