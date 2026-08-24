/**
 * 引擎不变量自动断言（TEX-16）。
 *
 * 复用引擎导出的权威不变量实现（`assertInvariants` 手级 + `assertTournamentInvariants`
 * 锦标赛级，docs/01-engine-spec.md §17），在模拟器中于每个合法状态转移后与每手结束后
 * 调用（docs/06-testing-strategy.md §4）。另校验主事件流 `sequence` 单调递增无缺口。
 *
 * 本模块不定义新不变量，不复制规则判断；引擎内部缺陷以错误消息透传。
 */
import { assertInvariants } from "../../../packages/poker-engine/src/engine/invariants";
import { assertTournamentInvariants } from "../../../packages/poker-engine/src/engine/tournament-invariants";
import type { PokerEvent } from "../../../packages/poker-engine/src/events/events";
import type { TournamentState } from "../../../packages/poker-engine/src/model/tournament";

/**
 * 断言锦标赛状态满足全部引擎不变量（手级 + 锦标赛级）。
 * 手级不变量对进行中与 `hand_end` 状态均适用（筹码守恒按阶段分支，见引擎实现）。
 */
export function assertTournamentStateInvariants(state: TournamentState): void {
  assertTournamentInvariants(state);
  if (state.hand) {
    assertInvariants(state.hand);
  }
}

/** 事件序列校验器：跟踪已消费的事件数，断言新事件的 sequence 严格 +1 递增。 */
export interface EventSequenceChecker {
  /** 传入主事件流全量数组；只检查新增尾部。 */
  observe(events: readonly PokerEvent[]): void;
  /** 已校验的事件总数。 */
  consumed(): number;
}

export function createEventSequenceChecker(): EventSequenceChecker {
  let consumedCount = 0;
  let lastSequence: number | null = null;
  return {
    observe(events: readonly PokerEvent[]): void {
      for (let i = consumedCount; i < events.length; i++) {
        const event = events[i]!;
        if (lastSequence !== null && event.sequence !== lastSequence + 1) {
          throw new Error(
            `事件序列不连续：第 ${i} 个事件 sequence=${event.sequence}，上一个为 ${lastSequence}`,
          );
        }
        if (lastSequence === null && event.sequence !== 0) {
          throw new Error(`事件序列未从 0 开始：首个事件 sequence=${event.sequence}`);
        }
        lastSequence = event.sequence;
      }
      consumedCount = events.length;
    },
    consumed(): number {
      return consumedCount;
    },
  };
}
