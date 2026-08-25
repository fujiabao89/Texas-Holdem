import { describe, it, expect } from "vitest";
import { createFakeClock, type FakeClock } from "../../../../tests/support/fake-clock";
import {
  createFakeCommitRepository,
  makeBundle,
  type FakeCommitRepository,
} from "../../tests/fixtures/persistence";
import { createPersistenceWriter, type PersistenceWriter, type PersistenceWriterDeps, type BackpressureLevel } from "./persistence-writer";

/** 让异步 processHead 链完成到某条件成立（确定性，无 sleep）。 */
async function until(cond: () => boolean, maxYields = 100): Promise<void> {
  for (let i = 0; i < maxYields; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  throw new Error("until: condition not met");
}

interface Harness {
  writer: PersistenceWriter;
  commit: FakeCommitRepository;
  clock: FakeClock;
  levels: BackpressureLevel[];
  integrityErrors: unknown[];
}

function setup(limits?: PersistenceWriterDeps["limits"]): Harness {
  const clock = createFakeClock({ now: 0 });
  const commit = createFakeCommitRepository();
  const levels: BackpressureLevel[] = [];
  const integrityErrors: unknown[] = [];
  const writer = createPersistenceWriter({
    commit,
    scheduler: clock,
    clock: () => clock.now(),
    random: () => 0.5, // jitter 中点 → 退避精确可断言
    onBackpressureChange: (level) => levels.push(level),
    onIntegrityError: (error) => integrityErrors.push(error),
    limits,
  });
  return { writer, commit, clock, levels, integrityErrors };
}

describe("PersistenceWriter", () => {
  it("成功写入：commit 推进水位、队列清空、指标正确", async () => {
    const { writer, commit } = setup();
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    await writer.flush(10_000);
    expect(commit.committed).toHaveLength(1);
    expect(writer.pendingCount()).toBe(0);
    expect(writer.lastCommittedSequence("t1")).toBe(3n);
    const metrics = writer.getMetrics();
    expect(metrics.lastCommittedSequence.get("t1")).toBe(3n);
    expect(metrics.level).toBe("ok");
  });

  it("重复投递幂等：同 hand 再次入队返回 already-committed，不产生重复行", async () => {
    const { writer, commit } = setup();
    const bundle = makeBundle("t1", 1, 1n, 3);
    writer.enqueue([bundle]);
    await writer.flush(10_000);
    writer.enqueue([bundle]); // 重复投递（同 hand id、同 checksum）
    await writer.flush(10_000);
    expect(commit.committed).toHaveLength(1);
    expect(commit.duplicated).toEqual([bundle.hand.id]);
    expect(writer.lastCommittedSequence("t1")).toBe(3n);
  });

  it("瞬态失败按指数退避重试：首次 250ms，重试成功后推进", async () => {
    const { writer, commit, clock } = setup();
    commit.failTransient = 1;
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    // 首次尝试失败 → 退避 timer 已调度，bundle 未丢弃。
    await until(() => clock.pendingTimers() > 0);
    expect(commit.committed).toHaveLength(0);
    expect(writer.pendingCount()).toBe(1);
    // 首次退避 = 250ms（jitter 中点）。
    clock.advance(250);
    await until(() => commit.committed.length === 1);
    expect(writer.pendingCount()).toBe(0);
    expect(writer.lastCommittedSequence("t1")).toBe(3n);
  });

  it("退避指数增长：连续失败后重试间隔为 250/500/1000ms", async () => {
    const clock = createFakeClock({ now: 0 });
    const commit = createFakeCommitRepository();
    const delays: number[] = [];
    // 记录式 scheduler：捕获每次退避调度延迟。
    const scheduler = {
      setTimeout(callback: () => void, delayMs: number) {
        delays.push(delayMs);
        return clock.setTimeout(callback, delayMs);
      },
      clearTimeout(handle: { id: number }) {
        clock.clearTimeout(handle);
      },
    };
    const writer = createPersistenceWriter({
      commit,
      scheduler,
      clock: () => clock.now(),
      random: () => 0.5,
    });
    commit.alwaysFail = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    // 逐次推进：每次退避到期触发重试，重试异步完成后再调度下一次。
    await until(() => delays.length === 1);
    expect(delays[0]).toBe(250);
    clock.advance(250);
    await until(() => delays.length === 2);
    expect(delays[1]).toBe(500);
    clock.advance(500);
    await until(() => delays.length === 3);
    expect(delays[2]).toBe(1000);
  });

  it("不同 Tournament 乱序完成：每桌内部顺序严格保持", async () => {
    const { writer, commit } = setup();
    // T1 与 T2 交替入队；每桌按 handNumber 顺序提交。
    writer.enqueue([makeBundle("t1", 1, 1n, 2)]);
    writer.enqueue([makeBundle("t2", 1, 1n, 2)]);
    writer.enqueue([makeBundle("t1", 2, 3n, 2)]);
    writer.enqueue([makeBundle("t2", 2, 3n, 2)]);
    await writer.flush(10_000);
    expect(commit.committed.map((b) => `${b.tournamentId}#${b.hand.handNumber}`)).toEqual([
      "t1#1",
      "t2#1",
      "t1#2",
      "t2#2",
    ]);
  });

  it("部分失败：一桌瞬态失败不影响另一桌提交，失败桌随后重试成功", async () => {
    const { writer, commit, clock } = setup();
    commit.failTransient = 1; // 下一次提交（T1 队头）失败
    writer.enqueue([makeBundle("t1", 1, 1n, 2)]);
    writer.enqueue([makeBundle("t2", 1, 1n, 2)]);
    await until(() => commit.committed.some((b) => b.tournamentId === "t2"));
    expect(commit.committed.map((b) => b.tournamentId)).toEqual(["t2"]);
    clock.advance(250); // T1 重试
    await until(() => commit.committed.length === 2);
    expect(commit.committed.map((b) => b.tournamentId).sort()).toEqual(["t1", "t2"]);
  });

  it("写入失败不回滚/不丢弃：DB 故障期间 bundle 保留在队列，恢复后继续", async () => {
    const { writer, commit, clock } = setup();
    commit.alwaysFail = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    await until(() => clock.pendingTimers() > 0);
    expect(writer.pendingCount()).toBe(1); // 未丢失
    commit.alwaysFail = false; // DB 恢复
    clock.advance(250);
    await until(() => commit.committed.length === 1);
    expect(writer.pendingCount()).toBe(0);
  });

  it("items watermark：soft 与 hard 逐级触发 onBackpressureChange", async () => {
    const { writer, commit, levels } = setup({
      softItems: 1, softBytes: Number.MAX_SAFE_INTEGER, softAgeMs: Number.MAX_SAFE_INTEGER,
      hardItems: 2, hardBytes: Number.MAX_SAFE_INTEGER, hardAgeMs: Number.MAX_SAFE_INTEGER,
      maxConcurrent: 1, backoffBaseMs: 250, backoffMaxMs: 30_000, backoffJitter: 0.2,
    });
    commit.alwaysFail = true; // 保持 bundle 在队列以观测 watermark
    writer.enqueue([makeBundle("t1", 1, 1n, 1)]);
    await until(() => levels.includes("soft"));
    writer.enqueue([makeBundle("t1", 2, 2n, 1)]);
    await until(() => levels.includes("hard"));
    expect(writer.backpressureLevel()).toBe("hard");
  });

  it("age watermark：最旧任务年龄达到阈值升级", async () => {
    const { writer, commit, clock, levels } = setup({
      softItems: 500, softBytes: Number.MAX_SAFE_INTEGER, softAgeMs: 1_000,
      hardItems: 2_000, hardBytes: Number.MAX_SAFE_INTEGER, hardAgeMs: 2_000,
      maxConcurrent: 1, backoffBaseMs: 250, backoffMaxMs: 30_000, backoffJitter: 0.2,
    });
    commit.alwaysFail = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 1)]);
    await until(() => clock.pendingTimers() > 0);
    expect(writer.backpressureLevel()).toBe("ok");
    clock.advance(1_000);
    await until(() => levels.includes("soft"));
    clock.advance(1_000);
    await until(() => levels.includes("hard"));
  });

  it("bytes watermark：估算字节达到 soft 即降级", async () => {
    const { writer, commit, levels } = setup({
      softItems: 500, softBytes: 100, softAgeMs: Number.MAX_SAFE_INTEGER,
      hardItems: 2_000, hardBytes: 5_000, hardAgeMs: Number.MAX_SAFE_INTEGER,
      maxConcurrent: 1, backoffBaseMs: 250, backoffMaxMs: 30_000, backoffJitter: 0.2,
    });
    commit.alwaysFail = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 1)]);
    await until(() => levels.includes("soft")); // bundle 字节 > 100
  });

  it("原生 PostgreSQL 完整性违例（SQLSTATE 23xxx）视为损坏：隔离而非无限重试", async () => {
    const { writer, commit, integrityErrors, clock } = setup();
    // 模拟 Drizzle/pg 透传的唯一键冲突（23505）：永久性数据不一致。
    commit.alwaysFail = true;
    commit.transientError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    await until(() => integrityErrors.length === 1);
    expect(writer.getMetrics().quarantined).toEqual(["t1"]);
    expect(writer.pendingCount()).toBe(1); // 保留不重试
    commit.alwaysFail = false;
    clock.advance(10_000);
    await until(() => integrityErrors.length === 1);
    expect(commit.committed).toHaveLength(0); // 未被重试提交
  });

  it("数据损坏（PersistenceError）隔离：不重试、上报、后续 bundle 保留", async () => {
    const { writer, commit, integrityErrors, clock } = setup();
    commit.failIntegrityOnce = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    await until(() => integrityErrors.length === 1);
    expect(writer.getMetrics().quarantined).toEqual(["t1"]);
    expect(writer.pendingCount()).toBe(1); // bundle 保留但不处理
    // 即使 DB 恢复、时间推进，也不重试损坏 bundle。
    commit.alwaysFail = false;
    clock.advance(10_000);
    await until(() => integrityErrors.length === 1);
    expect(commit.committed).toHaveLength(0);
    // 同一 Tournament 后续入队保留（隔离中的桌不再处理）。
    writer.enqueue([makeBundle("t1", 2, 4n, 3)]);
    expect(writer.pendingCount()).toBe(2);
  });

  it("flush：超时后返回（不挂起），未提交 bundle 保留", async () => {
    const { writer, commit, clock } = setup();
    commit.alwaysFail = true;
    writer.enqueue([makeBundle("t1", 1, 1n, 3)]);
    const pending = writer.flush(1_000);
    clock.advance(1_000); // 推进到 deadline → flush 返回
    await pending;
    // flush 超时后返回，未提交 bundle 未丢失。
    expect(writer.pendingCount()).toBe(1);
    // 故障恢复后可继续 flush 排空。
    commit.alwaysFail = false;
    await writer.flush(10_000);
    expect(writer.pendingCount()).toBe(0);
    expect(commit.committed).toHaveLength(1);
  });

  it("flush：排空全部待提交 bundle（正常路径）", async () => {
    const { writer, commit } = setup();
    for (let i = 1; i <= 5; i++) {
      writer.enqueue([makeBundle(`t${i}`, 1, 1n, 2)]);
    }
    await writer.flush(10_000);
    expect(writer.pendingCount()).toBe(0);
    expect(commit.committed).toHaveLength(5);
  });

  it("lastCommittedSequence 指标按 Tournament 分别跟踪", async () => {
    const { writer } = setup();
    writer.enqueue([makeBundle("t1", 1, 1n, 5), makeBundle("t2", 1, 1n, 7)]);
    await writer.flush(10_000);
    expect(writer.lastCommittedSequence("t1")).toBe(5n);
    expect(writer.lastCommittedSequence("t2")).toBe(7n);
    expect(writer.lastCommittedSequence("t3")).toBeNull();
  });
});
