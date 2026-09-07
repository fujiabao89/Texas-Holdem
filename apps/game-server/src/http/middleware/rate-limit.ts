/**
 * 进程内 Token Bucket 限流（docs/04-game-server-architecture.md §10.3）。
 *
 * 默认额度来自规格表：创建 5/min（burst 5）且 30/hour；邀请码 Join 20/min
 * （burst 10）；按 inviteCode 10/min；受保护 HTTP 变更 60/min（burst 20）。
 * 超额返回 `RATE_LIMITED` + `retryAfterMs`；多条件同时适用时取最严格者。
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/**
 * 限流档位（docs/04 §10.3）。默认档即规格表额度；`load-test` 仅用于隔离压测环境，
 * 显式提升 create/join 额度使 100 Room 级压测在窗口内可行。禁止在 NODE_ENV=production
 * 使用 load-test，避免生产误配放宽保护。额度差异随压测报告记录（可追溯配置差异）。
 */
export type RateLimitProfile = "default" | "load-test";

export function parseRateLimitProfile(
  env: Record<string, string | undefined> = process.env,
): RateLimitProfile {
  const raw = env.GAME_SERVER_RATE_LIMIT_PROFILE ?? "";
  if (raw === "" || raw === "default") return "default";
  if (raw === "load-test") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "GAME_SERVER_RATE_LIMIT_PROFILE=load-test is forbidden when NODE_ENV=production: it would relax create/join rate limits in production",
      );
    }
    return "load-test";
  }
  throw new Error(`GAME_SERVER_RATE_LIMIT_PROFILE must be 'default' or 'load-test', got ${JSON.stringify(raw)}`);
}

/** 各档位的额度表（capacity, refillPerSecond）。load-test 仍保留有界上限，不禁用限流。 */
interface ProfileLimits {
  readonly createPerMinute: { readonly capacity: number; readonly refillPerSecond: number };
  readonly createPerHour: { readonly capacity: number; readonly refillPerSecond: number };
  readonly joinPerIp: { readonly capacity: number; readonly refillPerSecond: number };
  readonly joinPerInviteCode: { readonly capacity: number; readonly refillPerSecond: number };
  readonly protectedPerPlayer: { readonly capacity: number; readonly refillPerSecond: number };
}

const LIMITS: Record<RateLimitProfile, ProfileLimits> = {
  default: {
    createPerMinute: { capacity: 5, refillPerSecond: 5 / 60 },
    createPerHour: { capacity: 30, refillPerSecond: 30 / 3600 },
    joinPerIp: { capacity: 10, refillPerSecond: 20 / 60 },
    joinPerInviteCode: { capacity: 10, refillPerSecond: 10 / 60 },
    protectedPerPlayer: { capacity: 20, refillPerSecond: 60 / 60 },
  },
  // 隔离压测档（默认关闭）：100 Room×10 WS / 突发 / 重连 / Soak / 130 Room 余量均需在
  // 压测窗口内高频建房、加入与换座。额度从分钟级提升到秒级有界值，仍按 IP 限流。
  "load-test": {
    createPerMinute: { capacity: 600, refillPerSecond: 600 / 60 },
    createPerHour: { capacity: 7200, refillPerSecond: 7200 / 3600 },
    joinPerIp: { capacity: 600, refillPerSecond: 600 / 60 },
    joinPerInviteCode: { capacity: 600, refillPerSecond: 600 / 60 },
    protectedPerPlayer: { capacity: 600, refillPerSecond: 600 / 60 },
  },
};

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  consume(): RateLimitResult {
    const current = this.now();
    const elapsedSeconds = Math.max(0, (current - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = current;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }
}

function stricter(a: RateLimitResult, b: RateLimitResult): RateLimitResult {
  if (!a.allowed && !b.allowed) {
    return { allowed: false, retryAfterMs: Math.max(a.retryAfterMs, b.retryAfterMs) };
  }
  return a.allowed && b.allowed ? { allowed: true, retryAfterMs: 0 } : a.allowed ? b : a;
}

export interface RateLimiter {
  checkCreateRoom(ip: string): RateLimitResult;
  checkJoinByIp(ip: string): RateLimitResult;
  checkJoinByInviteCode(inviteCode: string): RateLimitResult;
  checkProtected(playerId: string): RateLimitResult;
}

export function createRateLimiter(
  now: () => number = Date.now,
  profile: RateLimitProfile = "default",
): RateLimiter {
  const limits = LIMITS[profile];
  const buckets = new Map<string, TokenBucket>();

  function bucket(key: string, spec: { readonly capacity: number; readonly refillPerSecond: number }): TokenBucket {
    let existing = buckets.get(key);
    if (existing === undefined) {
      existing = new TokenBucket(spec.capacity, spec.refillPerSecond, now);
      buckets.set(key, existing);
    }
    return existing;
  }

  return {
    checkCreateRoom(ip) {
      const perMinute = bucket(`create:${ip}`, limits.createPerMinute);
      const perHour = bucket(`create-hour:${ip}`, limits.createPerHour);
      // 分钟桶拒绝时不消耗小时桶额度：被限流的请求不应提前耗尽小时配额。
      const minuteResult = perMinute.consume();
      if (!minuteResult.allowed) return minuteResult;
      return stricter(minuteResult, perHour.consume());
    },
    checkJoinByIp(ip) {
      return bucket(`join:${ip}`, limits.joinPerIp).consume();
    },
    checkJoinByInviteCode(inviteCode) {
      return bucket(`join-code:${inviteCode}`, limits.joinPerInviteCode).consume();
    },
    checkProtected(playerId) {
      return bucket(`protected:${playerId}`, limits.protectedPerPlayer).consume();
    },
  };
}
