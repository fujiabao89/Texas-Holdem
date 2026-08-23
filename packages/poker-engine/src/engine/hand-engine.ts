/**
 * PokerHandEngine 薄门面（TEX-14）。
 *
 * 持有一手牌的权威内部状态与事件日志，委托给纯 reducer（state-machine.ts）执行确定性转移。
 * 是调用方（game-server / 锦标赛层 / 模拟器）与规则层的唯一入口；`getState()` 为服务端内部权威状态。
 *
 * 权威规格：docs/01-engine-spec.md §5、§16。
 */
import type { GameState, HandConfig, HandOutcome } from "../model/hand";
import type { PlayerAction } from "../model/action";
import type { LegalActions } from "../model/legal";
import type { PokerEvent } from "../events/events";
import { createInitialState, legalForSeat, reduceHand } from "./state-machine";
import { assertInvariants } from "./invariants";

export class PokerHandEngine {
  private state: GameState;
  private events: PokerEvent[];

  constructor(config: HandConfig) {
    const result = createInitialState(config);
    this.state = result.state;
    this.events = [...result.events];
    assertInvariants(this.state); // 构造后自动断言（§17 / §16 运行时检测）
  }

  /** 当前行动者的合法动作（Engine 唯一合法动作来源；结束阶段抛错）。 */
  getLegalActions(): LegalActions {
    if (this.state.currentActor === null || this.state.phase !== this.state.street) {
      throw new Error("getLegalActions: 当前不在下注阶段");
    }
    return legalForSeat(this.state, this.state.currentActor);
  }

  /**
   * 校验并应用动作；非法则抛错且状态/事件/sequence 不变。
   * 返回下一行动者的 LegalActions；一手结束返回 null。
   */
  applyAction(action: PlayerAction): LegalActions | null {
    const result = reduceHand(this.state, action);
    this.state = result.state;
    this.events.push(...result.events);
    assertInvariants(this.state); // 每次合法动作后自动断言（§17）
    if (this.state.phase === "hand_end" || this.state.currentActor === null) {
      return null;
    }
    return legalForSeat(this.state, this.state.currentActor);
  }

  /** 服务端内部权威状态。 */
  getState(): GameState {
    return this.state;
  }

  /** 累计事件序列（内部权威流）。 */
  getEvents(): readonly PokerEvent[] {
    return Object.freeze([...this.events]);
  }

  isComplete(): boolean {
    return this.state.phase === "hand_end";
  }

  getOutcome(): HandOutcome | null {
    return this.state.outcome;
  }
}
