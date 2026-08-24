/**
 * 邀请码生成（docs/04-game-server-architecture.md §5.2；docs/02-protocol-spec.md §5）。
 *
 * - 固定 31 字符字母表，排除 0/O、1/I/L 等易混淆字符，生成 6 位大写邀请码；
 *   邀请码只是 Room Locator，不充当身份凭证。
 * - 使用密码学安全随机源逐字符 rejection sampling，禁止对随机字节直接取模造成偏差：
 *   31 × 8 = 248，字节 < 248 时取 `byte % 31`，>= 248 的字节拒绝重试，保证均匀。
 * - 冲突最多重试 10 次（每次完整重新生成）；连续 10 次冲突视为服务异常抛错，
 *   不得降级为更短邀请码或可预测序列。
 */

export const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_MAX_COLLISIONS = 10;

/** 字节上限：字母表长度 31 × 8 = 248；>= 248 的字节拒绝以避免取模偏差。 */
const BYTE_LIMIT = 248;

export type SecureRandomBytes = (count: number) => Uint8Array;

export class InviteCodeExhaustedError extends Error {
  constructor() {
    super("invite code generation exhausted after 10 collision retries");
    this.name = "InviteCodeExhaustedError";
  }
}

function nextAlphabetIndex(randomBytes: SecureRandomBytes): number {
  for (;;) {
    const [byte] = randomBytes(1);
    if (byte < BYTE_LIMIT) {
      return byte % INVITE_CODE_ALPHABET.length;
    }
  }
}

/** 生成一个 6 位邀请码（无偏 rejection sampling）。 */
export function generateInviteCode(randomBytes: SecureRandomBytes): string {
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_CODE_ALPHABET[nextAlphabetIndex(randomBytes)]!;
  }
  return code;
}

/**
 * 生成未占用的邀请码：冲突时完整重新生成，最多 10 次；
 * 全部冲突则抛 `InviteCodeExhaustedError`（由上层映射为可重试的 INTERNAL_ERROR/503）。
 */
export function generateUniqueInviteCode(
  randomBytes: SecureRandomBytes,
  isTaken: (candidate: string) => boolean,
): string {
  for (let attempt = 0; attempt < INVITE_CODE_MAX_COLLISIONS; attempt += 1) {
    const code = generateInviteCode(randomBytes);
    if (!isTaken(code)) {
      return code;
    }
  }
  throw new InviteCodeExhaustedError();
}
