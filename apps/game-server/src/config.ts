/**
 * Game Server 运行时配置（docs/04-game-server-architecture.md §10）。
 *
 * 敏感值只经环境注入：`TOKEN_HMAC_SECRET` 用于 playerToken 的 HMAC 摘要，
 * 绝不进入日志、DB 或客户端。CORS 使用显式 Allowlist，不使用通配来源。
 */

export interface AppConfig {
  readonly token: { readonly secret: string; readonly keyId: string; readonly secretsByKeyId: Readonly<Record<string, string>> };
  readonly corsAllowedOrigins: readonly string[];
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

export function parseAppConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const secret = env.TOKEN_HMAC_SECRET;
  if (secret === undefined || secret.trim() === "") {
    throw new AppConfigError("TOKEN_HMAC_SECRET is required");
  }
  if (secret.length < 32) {
    throw new AppConfigError("TOKEN_HMAC_SECRET must be at least 32 characters");
  }
  const keyId = env.TOKEN_HMAC_KEY_ID ?? "v1";
  assertKeyId(keyId, "TOKEN_HMAC_KEY_ID");
  const retained = parseRetainedTokenSecrets(env.TOKEN_HMAC_RETAINED_KEYS);
  if (retained[keyId] !== undefined) throw new AppConfigError("TOKEN_HMAC_RETAINED_KEYS must not redefine TOKEN_HMAC_KEY_ID");
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return { token: { secret, keyId, secretsByKeyId: Object.freeze({ ...retained, [keyId]: secret }) }, corsAllowedOrigins };
}

export function resolveTokenSecret(config: AppConfig, keyId: string): string | undefined {
  return config.token.secretsByKeyId[keyId];
}

function parseRetainedTokenSecrets(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AppConfigError("TOKEN_HMAC_RETAINED_KEYS must be a JSON object"); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new AppConfigError("TOKEN_HMAC_RETAINED_KEYS must be a JSON object");
  const entries = Object.entries(parsed);
  if (entries.length > 16) throw new AppConfigError("TOKEN_HMAC_RETAINED_KEYS supports at most 16 keys");
  const retained: Record<string, string> = {};
  for (const [keyId, secret] of entries) {
    assertKeyId(keyId, "TOKEN_HMAC_RETAINED_KEYS key");
    if (typeof secret !== "string" || secret.length < 32) throw new AppConfigError(`TOKEN_HMAC_RETAINED_KEYS secret for ${keyId} must be at least 32 characters`);
    retained[keyId] = secret;
  }
  return retained;
}

function assertKeyId(keyId: string, name: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new AppConfigError(`${name} must match [A-Za-z0-9._-]{1,64}`);
}
