import { describe, expect, it } from "vitest";
import { validateTournamentConfig } from "../../../packages/poker-engine/src/index";
import { createSeededRandom, deriveSeed } from "../../support/random";
import { AGENT_STYLES, generateScenario } from "./scenario";

/** 从 seed 生成场景的便捷入口。 */
function scenarioOf(seed: number) {
  return generateScenario(createSeededRandom(deriveSeed(seed, "scenario")));
}

describe("generateScenario 确定性与合法性", () => {
  it("同一 seed 恒生成同一场景", () => {
    expect(scenarioOf(20260821)).toEqual(scenarioOf(20260821));
  });

  it("不同 seed 生成不同场景（抽样）", () => {
    const scenarios = new Set([1, 2, 3, 4, 5].map((s) => scenarioOf(s).label + `#${scenarioOf(s).playerCount}`));
    expect(scenarios.size).toBeGreaterThan(1);
  });

  it("生成的配置全部通过引擎唯一校验入口（200 个场景）", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = scenarioOf(seed);
      expect(() =>
        validateTournamentConfig({
          maxPlayers: s.playerCount,
          startingStack: s.startingStack,
          smallBlind: s.smallBlind,
          bigBlind: s.bigBlind,
          blindMode: s.blindMode,
          blindStructure: s.blindStructure,
        }),
      ).not.toThrow();
      expect(s.startingStack).toBeGreaterThan(0);
      expect(s.smallBlind).toBeLessThan(s.bigBlind);
      expect(s.blindStructure[0]!.smallBlind).toBe(s.smallBlind);
      expect(s.blindStructure[0]!.bigBlind).toBe(s.bigBlind);
    }
  });
});

describe("generateScenario 加权覆盖（docs/06 §5）", () => {
  const SCENARIO_SEEDS = Array.from({ length: 400 }, (_, i) => 10_000 + i);

  it("覆盖 2/3/10 人与 4–9 人", () => {
    const counts = new Map<number, number>();
    for (const seed of SCENARIO_SEEDS) {
      const n = scenarioOf(seed).playerCount;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const n of [2, 3, 10]) {
      expect(counts.get(n) ?? 0, `玩家数 ${n} 未被覆盖`).toBeGreaterThan(0);
    }
    expect([...counts.keys()].some((n) => n >= 4 && n <= 9)).toBe(true);
  });

  it("覆盖三种盲注模式、全部风格与深浅筹码", () => {
    const modes = new Set<string>();
    const styles = new Set<string>();
    const depths = new Set<string>();
    for (const seed of SCENARIO_SEEDS) {
      const s = scenarioOf(seed);
      modes.add(s.blindMode);
      styles.add(s.agentStyle);
      depths.add(s.stackDepth);
    }
    expect([...modes].sort()).toEqual(["fixed", "hands", "time"]);
    expect([...styles].sort()).toEqual([...AGENT_STYLES].sort());
    expect([...depths].sort()).toEqual(["deep", "medium", "shallow"]);
  });

  it("hands/time 结构同时包含上升与下降等级（盲注可降）", () => {
    for (const seed of SCENARIO_SEEDS) {
      const s = scenarioOf(seed);
      if (s.blindMode === "fixed") continue;
      const bbs = s.blindStructure.map((l) => l.bigBlind);
      const hasUp = bbs.some((bb, i) => i > 0 && bb > bbs[i - 1]!);
      const hasDown = bbs.some((bb, i) => i > 0 && bb < bbs[i - 1]!);
      expect(hasUp, `seed ${seed} 无上升等级`).toBe(true);
      expect(hasDown, `seed ${seed} 无下降等级`).toBe(true);
    }
  });

  it("folding 风格只配浅筹码（避免深筹码磨牌退化）", () => {
    for (const seed of SCENARIO_SEEDS) {
      const s = scenarioOf(seed);
      if (s.agentStyle === "folding") {
        expect(s.stackDepth).toBe("shallow");
      }
    }
  });
});
