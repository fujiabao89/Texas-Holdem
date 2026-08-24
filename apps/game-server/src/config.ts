/**
 * Game Server 运行时配置（docs/04-game-server-architecture.md §10）。
 *
 * 敏感值只经环境注入：`TOKEN_HMAC_SECRET` 用于 playerToken 的 HMAC 摘要，
 * 绝不进入日志、DB 或客户端。CORS 使用显式 Allowlist，不使用通配来源。
 */

export interface AppConfig {
  readonly token: { readonly secret: string; readonly keyId: string };
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
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return { token: { secret, keyId }, corsAllowedOrigins };
}
