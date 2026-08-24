import { describe, expect, it } from "vitest";
import type { LegalActions } from "../../../packages/poker-engine/src/index";
import { createSeededRandom } from "../../support/random";
import type { SeededRandom } from "../../support/random";
import { chooseAction } from "./agent";
import { AGENT_STYLES } from "./scenario";

/** 构造 LegalActions 的便捷工厂（字段语义见 docs/01 §5.2）。 */
function legal(over: Partial<LegalActions> = {}): LegalActions {
  return {
    canFold: true,
    canCheck: false,
    canCall: true,
    callAmount: 40,
    canBet: false,
    minBetTo: null,
    canRaise: true,
    minRaiseTo: 80,
    maxRaiseTo: 300,
    canAllIn: true,
    allInTo: 300,
    ...over,
  };
}

/** 真实引擎状态下的合法性验证：跑完整锦标赛，断言从未抛出非法动作错误。 */
describe("chooseAction 只从 LegalActions 选择", () => {
  it("任意风格与随机流下，所选动作恒属于当前合法集合", () => {
    const cases: LegalActions[] = [
      legal(),
      legal({ canRaise: false, minRaiseTo: null, canCheck: true, canCall: false, callAmount: 0 }),
      legal({ canBet: true, minBetTo: 20, canRaise: false, minRaiseTo: null, canCall: false, callAmount: 0 }),
      legal({ canCheck: true, canCall: false, callAmount: 0, canRaise: false, minRaiseTo: null, canAllIn: false }),
      legal({ canAllIn: false, canRaise: true }),
    ];
    for (const style of AGENT_STYLES) {
      for (const [caseIndex, la] of cases.entries()) {
        const rng = createSeededRandom(9_100 + caseIndex * 100 + style.length);
        for (let draw = 0; draw < 300; draw++) {
          const action = chooseAction(7, la, rng, style);
          expect(action.seatIndex).toBe(7);
          expect(action.source).toBe("human_socket");
          switch (action.type) {
            case "fold":
              expect(la.canFold).toBe(true);
              expect(action.amount).toBeUndefined();
              break;
            case "check":
              expect(la.canCheck).toBe(true);
              expect(action.amount).toBeUndefined();
              break;
            case "call":
              expect(la.canCall).toBe(true);
              expect(action.amount).toBeUndefined();
              break;
            case "bet":
              expect(la.canBet).toBe(true);
              expect(action.amount!).toBeGreaterThanOrEqual(la.minBetTo!);
              expect(action.amount!).toBeLessThanOrEqual(la.maxRaiseTo);
              break;
            case "raise":
              expect(la.canRaise).toBe(true);
              expect(action.amount!).toBeGreaterThanOrEqual(la.minRaiseTo!);
              expect(action.amount!).toBeLessThanOrEqual(la.maxRaiseTo);
              break;
            case "all-in":
              expect(la.canAllIn).toBe(true);
              expect(action.amount).toBeUndefined();
              break;
          }
        }
      }
    }
  });

  it("同一 rng 状态恒选择同一动作（确定性）", () => {
    const run = (): ReturnType<typeof chooseAction> => {
      const rng: SeededRandom = createSeededRandom(42);
      return chooseAction(3, legal(), rng, "balanced");
    };
    expect(run()).toEqual(run());
  });

  it("LegalActions 无任何合法动作时显式抛错（引擎契约破坏）", () => {
    const empty = legal({
      canFold: false,
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canAllIn: false,
    });
    expect(() => chooseAction(1, empty, createSeededRandom(1), "balanced")).toThrow(/未提供任何合法动作/);
  });
});
