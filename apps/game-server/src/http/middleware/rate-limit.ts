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

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, TokenBucket>();

  function bucket(key: string, capacity: number, refillPerSecond: number): TokenBucket {
    let existing = buckets.get(key);
    if (existing === undefined) {
      existing = new TokenBucket(capacity, refillPerSecond, now);
      buckets.set(key, existing);
    }
    return existing;
  }

  return {
    checkCreateRoom(ip) {
      const perMinute = bucket(`create:${ip}`, 5, 5 / 60);
      const perHour = bucket(`create-hour:${ip}`, 30, 30 / 3600);
      // 分钟桶拒绝时不消耗小时桶额度：被限流的请求不应提前耗尽小时配额。
      const minuteResult = perMinute.consume();
      if (!minuteResult.allowed) return minuteResult;
      return stricter(minuteResult, perHour.consume());
    },
    checkJoinByIp(ip) {
      return bucket(`join:${ip}`, 10, 20 / 60).consume();
    },
    checkJoinByInviteCode(inviteCode) {
      return bucket(`join-code:${inviteCode}`, 10, 10 / 60).consume();
    },
    checkProtected(playerId) {
      return bucket(`protected:${playerId}`, 20, 60 / 60).consume();
    },
  };
}
