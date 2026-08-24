import { describe, expect, it } from "vitest";
import { CoverageStats, TIER_REQUIRED_CATEGORIES } from "./stats";
import type { HandRecord, TournamentRecord } from "./stats";
import type { SimulatorScenario } from "../random-hands/scenario";

const scenario: SimulatorScenario = {
  label: "test",
  playerCount: 3,
  startingStack: 1_000,
  smallBlind: 10,
  bigBlind: 20,
  blindMode: "hands",
  blindStructure: [
    { smallBlind: 10, bigBlind: 20, hands: 2 },
    { smallBlind: 5, bigBlind: 10, hands: 2 },
  ],
  stackDepth: "shallow",
  agentStyle: "aggressive",
  elapsedSecondsPerHand: 0,
};

function hand(over: Partial<HandRecord> = {}): HandRecord {
  return {
    handNumber: 1,
    playersAtStart: 3,
    smallBlind: 10,
    bigBlind: 20,
    previousBlinds: null,
    streets: ["flop"],
    showdown: false,
    potCount: 1,
    allInPlayers: 0,
    shortAllInCount: 0,
    actionCounts: { fold: 2 },
    winnerHandRanks: [],
    stackDepth: "shallow",
    agentStyle: "aggressive",
    ...over,
  };
}

function tournament(over: Partial<TournamentRecord> = {}): TournamentRecord {
  return {
    seed: 1,
    scenario,
    hands: [hand()],
    actionsTaken: 2,
    champion: 0,
    headsUpReached: false,
    ...over,
  };
}

describe("CoverageStats 聚合", () => {
  it("按类别正确计数", () => {
    const stats = new CoverageStats();
    stats.recordTournament(
      tournament({
        hands: [
          hand({ showdown: true, potCount: 2, allInPlayers: 2, shortAllInCount: 2, winnerHandRanks: ["One Pair"], previousBlinds: null, actionCounts: { call: 3, "all-in": 2 } }),
          hand({ handNumber: 2, bigBlind: 10, smallBlind: 5, previousBlinds: { sb: 10, bb: 20 }, actionCounts: { fold: 2 } }),
        ],
        headsUpReached: true,
      }),
    );
    expect(stats.get("tournament-complete")).toBe(1);
    expect(stats.get("players-3")).toBe(1);
    expect(stats.get("stack-shallow")).toBe(1);
    expect(stats.get("blind-mode-hands")).toBe(1);
    expect(stats.get("agent-style-aggressive")).toBe(1);
    expect(stats.get("heads-up-reached")).toBe(1);
    expect(stats.get("hands-total")).toBe(2);
    expect(stats.get("hand-showdown")).toBe(1);
    expect(stats.get("hand-fold-end")).toBe(1);
    expect(stats.get("pot-side")).toBe(1);
    expect(stats.get("pot-single")).toBe(1);
    expect(stats.get("allin-multi")).toBe(1);
    expect(stats.get("allin-short")).toBe(2);
    expect(stats.get("blind-decrease")).toBe(1);
    expect(stats.get("blind-increase")).toBe(0);
    expect(stats.get("action-fold")).toBe(2);
    expect(stats.get("action-call")).toBe(3);
    expect(stats.get("action-all-in")).toBe(2);
    expect(stats.get("rank-One Pair")).toBe(1);
    expect(stats.get("street-flop")).toBe(2);
  });

  it("summary 返回按键排序的聚合视图", () => {
    const stats = new CoverageStats();
    stats.recordTournament(tournament());
    const summary = stats.summary();
    expect(Object.keys(summary)).toEqual([...Object.keys(summary)].sort());
    expect(summary["tournament-complete"]).toBe(1);
  });
});

describe("覆盖空洞检测（分层运行必需类别）", () => {
  it("空统计时全部必需类别缺失", () => {
    const stats = new CoverageStats();
    expect(stats.missingCategories()).toEqual([...TIER_REQUIRED_CATEGORIES]);
  });

  it("构造性覆盖全部必需类别后无缺失", () => {
    const stats = new CoverageStats();
    const full: TournamentRecord = tournament({
      scenario: { ...scenario, playerCount: 10, stackDepth: "deep" },
      hands: [
        hand({
          streets: ["flop", "turn", "river"],
          showdown: true,
          potCount: 2,
          allInPlayers: 2,
          shortAllInCount: 1,
          previousBlinds: { sb: 5, bb: 10 },
          actionCounts: { fold: 1, check: 1, call: 1, bet: 1, raise: 1, "all-in": 1 },
        }),
        hand({ handNumber: 2, smallBlind: 5, bigBlind: 10, previousBlinds: { sb: 10, bb: 20 } }),
      ],
      headsUpReached: true,
    });
    stats.recordTournament(full);
    stats.recordTournament(tournament({ scenario: { ...scenario, playerCount: 2 } }));
    stats.recordTournament(tournament({ scenario: { ...scenario, playerCount: 3 } }));
    stats.recordTournament(tournament({ scenario: { ...scenario, blindMode: "fixed", blindStructure: [{ smallBlind: 10, bigBlind: 20 }], stackDepth: "shallow" } }));
    stats.recordTournament(tournament({ scenario: { ...scenario, blindMode: "time", blindStructure: [{ smallBlind: 10, bigBlind: 20, durationSeconds: 60 }], stackDepth: "shallow" } }));
    expect(stats.missingCategories()).toEqual([]);
  });
});
