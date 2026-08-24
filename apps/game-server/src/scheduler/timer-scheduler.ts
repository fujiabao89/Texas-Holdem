/**
 * Timer Scheduler 接口与生产实现（docs/04-game-server-architecture.md §8）。
 *
 * - 执行器通过本接口调度行动超时 / 断线宽限等计时任务；Timer 到期只投递队列命令，
 *   不直接 mutate（§8.2）。取消依赖 generation 失效而非底层 clearTimeout 是否及时。
 * - 测试注入 `tests/support/fake-clock.ts`（FakeClock 满足本接口：`setTimeout`
 *   返回 `{id}`、`clearTimeout` 接受 `{id}`），实现 deterministic 时间推进；
 *   生产实现包装 Node `setTimeout`/`clearTimeout`。
 */

export interface TimerHandle {
  readonly id: number;
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 生产实现：委托 Node.js 计时器。 */
export function createNodeTimerScheduler(): TimerScheduler {
  let nextId = 1;
  const active = new Map<number, NodeJS.Timeout>();
  return {
    setTimeout(callback, delayMs) {
      const id = nextId++;
      const timeout = setTimeout(() => {
        active.delete(id);
        callback();
      }, delayMs);
      active.set(id, timeout);
      return { id };
    },
    clearTimeout(handle) {
      const timeout = active.get(handle.id);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        active.delete(handle.id);
      }
    },
  };
}
