/**
 * 背压 latch（docs/04-game-server-architecture.md §12.2）。
 *
 * hard watermark 一旦命中，**保持暂停直到队列回落到 ok（低于 soft）**才解除
 * （「恢复到 soft watermark 以下后才可继续」）：软降级（soft）不解除 hard 暂停，
 * 避免在仍处于退化状态时重启手、反复填满队列。`isHardPaused()` 供执行器在手间
 * 边界**同步**检查（new/hard 边界 bundle 自身触达 hard 时也能在推进下一手前停下）。
 */
import type { BackpressureLevel } from "./persistence-writer";

export interface BackpressureLatch {
  readonly hardPaused: boolean;
  /** 由 Writer 的 onBackpressureChange 调用；记录级别迁移。 */
  onLevel(level: BackpressureLevel): void;
  isHardPaused(): boolean;
}

export function createBackpressureLatch(): BackpressureLatch {
  let hardPaused = false;
  return {
    get hardPaused() {
      return hardPaused;
    },
    onLevel(level) {
      if (level === "hard") {
        hardPaused = true;
      } else if (level === "ok") {
        // 仅回落到 ok（低于 soft）才解除 hard 暂停（§12.2）。
        hardPaused = false;
      }
      // soft 保持现状：从未 hard 则继续运行；曾 hard 则保持暂停。
    },
    isHardPaused() {
      return hardPaused;
    },
  };
}
