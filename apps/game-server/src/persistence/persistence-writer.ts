/**
 * 持久化异步 Writer（docs/03-data-model.md §7；docs/04-game-server-architecture.md §12）。
 *
 * 唯一写者的异步编排：接收 `HandCommitBundle`，按 Tournament **严格串行**（同一
 * Tournament 的手末提交不得越过前一手的提交，§7.1）、全局最多 `WRITER_MAX_CONCURRENT`
 * 路并发写入 PostgreSQL。Action 热路径不等待 DB；DB 短暂故障不阻塞/回滚当前 Hand，
 * 写失败进入有界内存队列并按指数退避重试（§12.1）。
 *
 * 关键语义：
 * - **幂等重试**：bundle 携带预生成 ID 与确定性事件序列；重试经仓储幂等判定返回
 *   `already-committed`（相同 commit_checksum）视为成功推进（§7.4）。
 * - **数据损坏**：`PersistenceError` 系列（checksum 不匹配/序列缺口/部分冲突/目标
 *   缺失）**不得**静默重试或覆盖（§7.4）——隔离该 Tournament 并上报 `onIntegrityError`，
 *   后续 bundle 保留但不再尝试，等待人工处置（§13）。
 * - **watermark**：按任务数 / 估算字节数 / 最旧任务年龄三维执行 soft/hard 阈值
 *   （§10.3/§12.2），任一维度命中即升级；变化时回调 `onBackpressureChange`。
 * - **flush**：优雅关停时最多用 `timeoutMs` 排空队列（§13.1），超时记录未提交数后返回；
 *   flush 强制忽略退避 timer、以 deadline timer 兜底，不挂起。
 *
 * Writer 不丢弃、不覆盖未提交 Commit Bundle；重试失败不回滚内存 GameState、不重放 Action。
 * 字节估算使用 canonical JSON（`stableStringify`），BigInt 十进制、键排序，与 checksum 一致。
 */

import type {
  HandCommitBundle,
  HandCommitRepository,
} from "../infrastructure/persistence/repositories/hand-commit";
import { PersistenceError } from "../infrastructure/persistence/repositories/errors";
import { stableStringify } from "../infrastructure/persistence/checksum";
import type { TimerHandle, TimerScheduler } from "../scheduler/timer-scheduler";

// ---- 参数（docs/04 §10.3 持久化待提交队列 / §12.1 重试与有序性） ----

/** soft watermark：500 Bundles / 128MiB / oldest 60s。 */
export const WRITER_SOFT_ITEMS = 500;
export const WRITER_SOFT_BYTES = 128 * 1024 * 1024;
export const WRITER_SOFT_AGE_MS = 60_000;
/** hard watermark：2,000 Bundles / 512MiB / oldest 10min。 */
export const WRITER_HARD_ITEMS = 2_000;
export const WRITER_HARD_BYTES = 512 * 1024 * 1024;
export const WRITER_HARD_AGE_MS = 10 * 60 * 1000;
/** 不同 Tournament 最多 8 路并发写入（§12.1）。 */
export const WRITER_MAX_CONCURRENT = 8;
/** 单次 DB 尝试 5 秒超时（§12.1；由仓储侧负责，此处为对齐常量）。 */
export const WRITER_DB_TIMEOUT_MS = 5_000;
/** 指数退避：`250ms × 2^attempt`、±20% jitter、最高 30 秒（§12.1）。 */
export const WRITER_BACKOFF_BASE_MS = 250;
export const WRITER_BACKOFF_MAX_MS = 30_000;
export const WRITER_BACKOFF_JITTER = 0.2;
/** flush 阶段单次重试退避上限（不无限退避，配合 deadline 兜底）。 */
const FLUSH_RETRY_CAP_MS = 1_000;

export type BackpressureLevel = "ok" | "soft" | "hard";

export interface PersistenceWriterLimits {
  readonly softItems: number;
  readonly softBytes: number;
  readonly softAgeMs: number;
  readonly hardItems: number;
  readonly hardBytes: number;
  readonly hardAgeMs: number;
  readonly maxConcurrent: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly backoffJitter: number;
}

export interface PersistenceWriterDeps {
  readonly commit: HandCommitRepository;
  /** 退避/重试调度（生产 Node timer；测试 Fake Clock）。 */
  readonly scheduler: TimerScheduler;
  readonly clock: () => number;
  /** watermark 级别变化回调（soft/hard 告警、PERSISTENCE_DEGRADED 状态切换）。 */
  readonly onBackpressureChange?: (level: BackpressureLevel) => void;
  /** 数据损坏（PersistenceError）回调：隔离 + 告警，不静默重试。 */
  readonly onIntegrityError?: (error: unknown, bundle: HandCommitBundle) => void;
  /** jitter 随机源（测试可注入确定性 PRNG）。 */
  readonly random?: () => number;
  readonly limits?: Partial<PersistenceWriterLimits>;
}

export interface WriterMetrics {
  readonly level: BackpressureLevel;
  readonly items: number;
  readonly bytes: number;
  readonly oldestPendingAgeMs: number | null;
  /** 全局最近一次 DB 延迟（成功或失败尝试）。 */
  readonly lastDbLatencyMs: number | null;
  /** 各 Tournament 最近一次已提交 sequence（尚无提交为 null）。 */
  readonly lastCommittedSequence: ReadonlyMap<string, bigint>;
  /** 全局最大连续失败数（供告警）。 */
  readonly consecutiveFailures: number;
  /** 隔离中的数据损坏 Tournament（供运维观测）。 */
  readonly quarantined: readonly string[];
}

export interface PersistenceWriter {
  /** 入队手末 Commit Bundle（同步；永不丢弃，超限由 backpressure 上游处理）。 */
  enqueue(bundles: readonly HandCommitBundle[]): void;
  /** 优雅关停排空：最多 `timeoutMs` 毫秒内尽力提交全部未提交 bundle。 */
  flush(timeoutMs?: number): Promise<void>;
  pendingCount(): number;
  backpressureLevel(): BackpressureLevel;
  getMetrics(): WriterMetrics;
  lastCommittedSequence(tournamentId: string): bigint | null;
}

interface BundleEntry {
  readonly bundle: HandCommitBundle;
  readonly enqueuedAt: number;
  readonly bytes: number;
}

interface TournamentQueue {
  pending: BundleEntry[];
  retryTimer: TimerHandle | null;
  retryAt: number;
  attempt: number;
  consecutiveFailures: number;
  lastCommitted: bigint | null;
}

export function createPersistenceWriter(deps: PersistenceWriterDeps): PersistenceWriter {
  const limits: PersistenceWriterLimits = {
    softItems: WRITER_SOFT_ITEMS,
    softBytes: WRITER_SOFT_BYTES,
    softAgeMs: WRITER_SOFT_AGE_MS,
    hardItems: WRITER_HARD_ITEMS,
    hardBytes: WRITER_HARD_BYTES,
    hardAgeMs: WRITER_HARD_AGE_MS,
    maxConcurrent: WRITER_MAX_CONCURRENT,
    backoffBaseMs: WRITER_BACKOFF_BASE_MS,
    backoffMaxMs: WRITER_BACKOFF_MAX_MS,
    backoffJitter: WRITER_BACKOFF_JITTER,
    ...deps.limits,
  };
  const random = deps.random ?? Math.random;
  const queues = new Map<string, TournamentQueue>();
  const inflight = new Set<string>();
  const quarantined = new Set<string>();
  const lastDbLatency = { value: null as number | null };
  let maxConsecutiveFailures = 0;
  let level: BackpressureLevel = "ok";
  let flushing = false;
  let flushDeadline = Infinity;
  let flushResolvers: (() => void)[] = [];

  function queueFor(tournamentId: string): TournamentQueue {
    let queue = queues.get(tournamentId);
    if (queue === undefined) {
      queue = {
        pending: [],
        retryTimer: null,
        retryAt: 0,
        attempt: 0,
        consecutiveFailures: 0,
        lastCommitted: null,
      };
      queues.set(tournamentId, queue);
    }
    return queue;
  }

  function pendingTotal(): number {
    let total = 0;
    for (const queue of queues.values()) total += queue.pending.length;
    return total;
  }

  function oldestPendingAt(): number | null {
    let oldest: number | null = null;
    for (const queue of queues.values()) {
      const head = queue.pending[0];
      if (head !== undefined && (oldest === null || head.enqueuedAt < oldest)) oldest = head.enqueuedAt;
    }
    return oldest;
  }

  function evaluateWatermark(): BackpressureLevel {
    let items = 0;
    let bytes = 0;
    for (const queue of queues.values()) {
      items += queue.pending.length;
      for (const entry of queue.pending) bytes += entry.bytes;
    }
    const oldest = oldestPendingAt();
    const age = oldest === null ? 0 : Math.max(0, deps.clock() - oldest);
    let next: BackpressureLevel = "ok";
    if (items >= limits.hardItems || bytes >= limits.hardBytes || age >= limits.hardAgeMs) {
      next = "hard";
    } else if (items >= limits.softItems || bytes >= limits.softBytes || age >= limits.softAgeMs) {
      next = "soft";
    }
    if (next !== level) {
      level = next;
      deps.onBackpressureChange?.(level);
    }
    return next;
  }

  function backoffMs(attempt: number): number {
    const exponential = Math.min(limits.backoffBaseMs * 2 ** attempt, limits.backoffMaxMs);
    const jitterFactor = 1 + (random() * 2 - 1) * limits.backoffJitter;
    return Math.round(exponential * jitterFactor);
  }

  function isIntegrityError(error: unknown): boolean {
    return error instanceof PersistenceError;
  }

  /**
   * 状态变化通知：空闲（无 in-flight）与 flush 完成条件（排空 / 到达 deadline）统一在此结算，
   * 避免 flush 在「有退避 timer 但无 in-flight」时空转。
   */
  function notifyStateChanged(): void {
    if (flushing && (pendingTotal() === 0 || deps.clock() >= flushDeadline)) {
      const resolvers = flushResolvers;
      flushResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /** 尝试提交某 Tournament 队头；成功/损坏/失败后都推进调度。 */
  async function processHead(tournamentId: string): Promise<void> {
    const queue = queueFor(tournamentId);
    const head = queue.pending[0];
    if (head === undefined) {
      inflight.delete(tournamentId);
      notifyStateChanged();
      return;
    }
    const startedAt = deps.clock();
    try {
      await deps.commit.commitHandBundle(head.bundle);
      lastDbLatency.value = deps.clock() - startedAt;
    } catch (error) {
      lastDbLatency.value = deps.clock() - startedAt;
      if (isIntegrityError(error)) {
        // 数据损坏：隔离该 Tournament，保留 bundle 但不再尝试（§7.4/§13）。
        quarantined.add(tournamentId);
        queue.consecutiveFailures += 1;
        maxConsecutiveFailures = Math.max(maxConsecutiveFailures, queue.consecutiveFailures);
        deps.onIntegrityError?.(error, head.bundle);
        evaluateWatermark();
        inflight.delete(tournamentId);
        notifyStateChanged();
        return;
      }
      // 瞬态失败：指数退避后重试队头；bundle 不丢弃、不覆盖。
      // 退避 = 250ms × 2^attempt（attempt 为已失败次数：首次失败 → 250ms，指数递增）。
      const delay = flushing
        ? Math.min(backoffMs(queue.attempt), FLUSH_RETRY_CAP_MS)
        : backoffMs(queue.attempt);
      queue.attempt += 1;
      queue.consecutiveFailures += 1;
      maxConsecutiveFailures = Math.max(maxConsecutiveFailures, queue.consecutiveFailures);
      const timer = deps.scheduler.setTimeout(() => {
        queue.retryTimer = null;
        if (queue.pending.length > 0) kick();
      }, delay);
      queue.retryTimer = timer;
      queue.retryAt = deps.clock() + delay;
      evaluateWatermark(); // 退避中任务仍占用队列 → 年龄/字节持续计入 watermark
      inflight.delete(tournamentId);
      notifyStateChanged();
      return;
    }
    // 成功（首次提交或幂等 already-committed）：推进队头与水位。
    queue.pending.shift();
    queue.lastCommitted = head.bundle.snapshot.sequence;
    queue.attempt = 0;
    queue.consecutiveFailures = 0;
    if (queue.retryTimer !== null) {
      deps.scheduler.clearTimeout(queue.retryTimer);
      queue.retryTimer = null;
    }
    evaluateWatermark();
    inflight.delete(tournamentId);
    notifyStateChanged();
    kick();
  }

  /** 触发可启动的 Tournament 处理；遵守并发上限与 backpressure/flush 状态。 */
  function kick(): void {
    if (flushing && deps.clock() >= flushDeadline) return;
    for (const [tournamentId, queue] of queues) {
      if (inflight.size >= limits.maxConcurrent) break;
      if (inflight.has(tournamentId)) continue;
      if (quarantined.has(tournamentId)) continue;
      if (queue.pending.length === 0) continue;
      if (queue.retryTimer !== null) continue; // 退避中，等待 timer 到期
      inflight.add(tournamentId);
      void processHead(tournamentId);
    }
  }

  function enqueue(bundles: readonly HandCommitBundle[]): void {
    for (const bundle of bundles) {
      const queue = queueFor(bundle.tournamentId);
      queue.pending.push({
        bundle,
        enqueuedAt: deps.clock(),
        bytes: stableStringify(bundle).length,
      });
    }
    evaluateWatermark();
    notifyStateChanged();
    kick();
  }

  async function flush(timeoutMs: number = WRITER_DB_TIMEOUT_MS * 6): Promise<void> {
    flushing = true;
    flushDeadline = deps.clock() + timeoutMs;
    let deadlineTimer: TimerHandle | null = null;
    try {
      // 强制忽略退避 timer：立即重试队头，直到耗尽 deadline。
      for (const [tournamentId, queue] of queues) {
        if (queue.retryTimer !== null && queue.pending.length > 0 && !quarantined.has(tournamentId)) {
          deps.scheduler.clearTimeout(queue.retryTimer);
          queue.retryTimer = null;
          queue.retryAt = 0;
        }
      }
      kick();
      if (pendingTotal() === 0) return;
      const remaining = Math.max(0, flushDeadline - deps.clock());
      // deadline 兜底：即使无任何状态推进（例如反复瞬态失败），到点也返回。
      deadlineTimer = deps.scheduler.setTimeout(() => notifyStateChanged(), remaining);
      while (pendingTotal() > 0 && deps.clock() < flushDeadline) {
        await new Promise<void>((resolve) => flushResolvers.push(resolve));
      }
    } finally {
      if (deadlineTimer !== null) deps.scheduler.clearTimeout(deadlineTimer);
      flushing = false;
    }
  }

  function getMetrics(): WriterMetrics {
    let items = 0;
    let bytes = 0;
    for (const queue of queues.values()) {
      items += queue.pending.length;
      for (const entry of queue.pending) bytes += entry.bytes;
    }
    const oldest = oldestPendingAt();
    return {
      level,
      items,
      bytes,
      oldestPendingAgeMs: oldest === null ? null : Math.max(0, deps.clock() - oldest),
      lastDbLatencyMs: lastDbLatency.value,
      lastCommittedSequence: new Map(
        [...queues.entries()]
          .filter(([, q]) => q.lastCommitted !== null)
          .map(([tid, q]) => [tid, q.lastCommitted!]),
      ),
      consecutiveFailures: maxConsecutiveFailures,
      quarantined: [...quarantined],
    };
  }

  return {
    enqueue,
    flush,
    pendingCount: pendingTotal,
    backpressureLevel: () => level,
    getMetrics,
    lastCommittedSequence(tournamentId) {
      return queues.get(tournamentId)?.lastCommitted ?? null;
    },
  };
}
