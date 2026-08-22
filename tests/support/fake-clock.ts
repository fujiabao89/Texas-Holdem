/**
 * Fake Clock / 受控计时工具（TEX-12）。
 *
 * 纯同步、可注入的时钟与定时器注册表：支持手动推进时间、按到期顺序执行回调，
 * 并可在 `dispose()` 后断言没有遗留 timer。不读写系统时间，不注册真实
 * setTimeout/setInterval，因此不会泄漏到全局或影响并行测试。
 */

export interface FakeTimerHandle {
  readonly id: number;
}

interface RegisteredTimer {
  readonly id: number;
  readonly kind: "timeout" | "interval";
  dueAt: number;
  readonly intervalMs: number | undefined;
  readonly callback: () => void;
  readonly sequence: number;
}

export interface FakeClock {
  /** 当前虚拟时间（Unix 毫秒）。 */
  now(): number;
  /** 手动推进 `ms` 毫秒，按到期时间（同刻按注册顺序）同步执行到期回调。 */
  advance(ms: number): void;
  setTimeout(callback: () => void, delayMs: number): FakeTimerHandle;
  clearTimeout(handle: FakeTimerHandle): boolean;
  setInterval(callback: () => void, intervalMs: number): FakeTimerHandle;
  clearInterval(handle: FakeTimerHandle): boolean;
  /** 当前尚未触发/仍在排队的 timer 数量；用于泄漏断言。 */
  pendingTimers(): number;
  /** 丢弃全部 timer（含未触发的 interval）；返回丢弃数量。 */
  dispose(): number;
}

export function createFakeClock(options?: { now?: number | Date }): FakeClock {
  const start =
    options?.now === undefined
      ? 0
      : options.now instanceof Date
        ? options.now.getTime()
        : options.now;
  if (!Number.isFinite(start)) {
    throw new Error(`createFakeClock: 非法起始时间 ${start}`);
  }

  let nowMs = start;
  let nextId = 1;
  let nextSequence = 1;
  const timers = new Map<number, RegisteredTimer>();

  function schedule(
    kind: "timeout" | "interval",
    callback: () => void,
    delayMs: number,
  ): FakeTimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`createFakeClock.${kind}: 非法延迟 ${delayMs}ms`);
    }
    const id = nextId++;
    timers.set(id, {
      id,
      kind,
      dueAt: nowMs + delayMs,
      intervalMs: kind === "interval" ? delayMs : undefined,
      callback,
      sequence: nextSequence++,
    });
    return { id };
  }

  function clear(handle: FakeTimerHandle, expectedKind: "timeout" | "interval"): boolean {
    const timer = timers.get(handle.id);
    if (!timer || timer.kind !== expectedKind) {
      return false;
    }
    timers.delete(handle.id);
    return true;
  }

  function nextDueTimer(target: number): RegisteredTimer | undefined {
    let selected: RegisteredTimer | undefined;
    for (const timer of timers.values()) {
      if (timer.dueAt > target) {
        continue;
      }
      if (
        !selected ||
        timer.dueAt < selected.dueAt ||
        (timer.dueAt === selected.dueAt && timer.sequence < selected.sequence)
      ) {
        selected = timer;
      }
    }
    return selected;
  }

  return {
    now() {
      return nowMs;
    },
    advance(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`FakeClock.advance: 非法推进量 ${ms}ms`);
      }
      const target = nowMs + ms;
      // 循环执行到期任务；执行中注册的新任务若落在窗口内也会被处理。
      for (;;) {
        const timer = nextDueTimer(target);
        if (!timer) {
          break;
        }
        nowMs = timer.dueAt;
        if (timer.kind === "timeout") {
          timers.delete(timer.id);
        } else {
          timer.dueAt = nowMs + (timer.intervalMs ?? 0);
        }
        timer.callback();
      }
      nowMs = target;
    },
    setTimeout: (callback, delayMs) => schedule("timeout", callback, delayMs),
    clearTimeout: (handle) => clear(handle, "timeout"),
    setInterval: (callback, intervalMs) => schedule("interval", callback, intervalMs),
    clearInterval: (handle) => clear(handle, "interval"),
    pendingTimers() {
      return timers.size;
    },
    dispose(): number {
      const dropped = timers.size;
      timers.clear();
      return dropped;
    },
  };
}
