import { describe, it, expect } from "vitest";
import {
  validateTournamentConfig,
  computeBlindLevelIndex,
  resolveBlindLevel,
  nextTournamentDealer,
  sortEliminationGroup,
} from "./tournament";
import type { TournamentConfigInput } from "../model/tournament";

function base(over: Partial<TournamentConfigInput> = {}): TournamentConfigInput {
  return {
    maxPlayers: 6,
    startingStack: 1000,
    smallBlind: 10,
    bigBlind: 20,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 10, bigBlind: 20 }],
    ...over,
  };
}

describe("validateTournamentConfig", () => {
  it("合法配置返回冻结规范值并补缺省", () => {
    const cfg = validateTournamentConfig(base());
    expect(cfg.actionTime).toBe(30); // 默认 30 秒
    expect(cfg.timeBank).toBe(60); // 默认 60 秒
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => validateTournamentConfig(base({ actionTime: 45, timeBank: 120 }))).not.toThrow();
  });

  it("拒绝非法 maxPlayers / startingStack / 盲注金额", () => {
    expect(() => validateTournamentConfig(base({ maxPlayers: 1 }))).toThrow();
    expect(() => validateTournamentConfig(base({ maxPlayers: 11 }))).toThrow();
    expect(() => validateTournamentConfig(base({ startingStack: 0 }))).toThrow();
    expect(() => validateTournamentConfig(base({ startingStack: -5 }))).toThrow();
    expect(() => validateTournamentConfig(base({ smallBlind: 20, bigBlind: 10 }))).toThrow(); // SB>=BB
    expect(() => validateTournamentConfig(base({ smallBlind: 1.5 }))).toThrow();
  });

  it("拒绝非法 blindMode / blindStructure（空、SB>=BB、坏金额）", () => {
    expect(() => validateTournamentConfig(base({ blindMode: "x" as never }))).toThrow();
    expect(() => validateTournamentConfig(base({ blindStructure: [] }))).toThrow();
    expect(() =>
      validateTournamentConfig(base({ blindStructure: [{ smallBlind: 20, bigBlind: 10 }] })),
    ).toThrow();
  });

  it("hands 模式每级需 hands；time 模式每级需 durationSeconds；fixed 模式仅 1 级", () => {
    expect(() =>
      validateTournamentConfig(
        base({ blindMode: "hands", blindStructure: [{ smallBlind: 10, bigBlind: 20 }] }),
      ),
    ).toThrow();
    expect(() =>
      validateTournamentConfig(
        base({
          blindMode: "hands",
          blindStructure: [
            { smallBlind: 10, bigBlind: 20, hands: 5 },
            { smallBlind: 20, bigBlind: 40, hands: 5 },
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateTournamentConfig(
        base({ blindMode: "time", blindStructure: [{ smallBlind: 10, bigBlind: 20 }] }),
      ),
    ).toThrow();
    expect(() =>
      validateTournamentConfig(
        base({
          blindMode: "time",
          blindStructure: [{ smallBlind: 10, bigBlind: 20, durationSeconds: 300 }],
        }),
      ),
    ).not.toThrow();
    // fixed 模式多级（本应只有 1 级）→ 拒绝。
    expect(() =>
      validateTournamentConfig(
        base({
          blindStructure: [
            { smallBlind: 10, bigBlind: 20 },
            { smallBlind: 20, bigBlind: 40 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("盲注下降合法：每级独立校验，不继承上一级最小加注", () => {
    // 等级 2 BB 小于等级 1（下降），仍合法。
    expect(() =>
      validateTournamentConfig(
        base({
          blindMode: "hands",
          blindStructure: [
            { smallBlind: 10, bigBlind: 20, hands: 5 },
            { smallBlind: 5, bigBlind: 10, hands: 5 },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("blindStructure[0] 须等于 smallBlind/bigBlind", () => {
    expect(() =>
      validateTournamentConfig(base({ blindStructure: [{ smallBlind: 15, bigBlind: 30 }] })),
    ).toThrow();
  });

  it("UNLIMITED 时 timeBank 须为 0；非法 actionTime 档位被拒", () => {
    expect(() => validateTournamentConfig(base({ actionTime: "UNLIMITED", timeBank: 0 }))).not.toThrow();
    expect(() => validateTournamentConfig(base({ actionTime: "UNLIMITED", timeBank: 60 }))).toThrow();
    expect(() => validateTournamentConfig(base({ actionTime: 25 as never }))).toThrow();
    expect(() => validateTournamentConfig(base({ timeBank: 45 as never }))).toThrow();
  });
});

describe("computeBlindLevelIndex", () => {
  const handsStructure = [
    { smallBlind: 10, bigBlind: 20, hands: 5 },
    { smallBlind: 20, bigBlind: 40, hands: 5 },
  ];
  const timeStructure = [
    { smallBlind: 10, bigBlind: 20, durationSeconds: 300 },
    { smallBlind: 20, bigBlind: 40, durationSeconds: 300 },
  ];

  it("fixed 恒为 0", () => {
    expect(computeBlindLevelIndex("fixed", [{ smallBlind: 10, bigBlind: 20 }], 50, 0)).toBe(0);
  });

  it("按手数：每 5 手，第 6 手进入新等级；超过末级钳制", () => {
    expect(computeBlindLevelIndex("hands", handsStructure, 1, 0)).toBe(0);
    expect(computeBlindLevelIndex("hands", handsStructure, 5, 0)).toBe(0); // 第 5 手仍等级 0
    expect(computeBlindLevelIndex("hands", handsStructure, 6, 0)).toBe(1); // 第 6 手新等级
    expect(computeBlindLevelIndex("hands", handsStructure, 10, 0)).toBe(1);
    expect(computeBlindLevelIndex("hands", handsStructure, 11, 0)).toBe(1); // 钳制到末级
  });

  it("按时间：累计秒数换级", () => {
    expect(computeBlindLevelIndex("time", timeStructure, 1, 0)).toBe(0);
    expect(computeBlindLevelIndex("time", timeStructure, 1, 300)).toBe(0);
    expect(computeBlindLevelIndex("time", timeStructure, 1, 301)).toBe(1);
    expect(computeBlindLevelIndex("time", timeStructure, 1, 600)).toBe(1);
  });

  it("下降盲注后 resolveBlindLevel 返回当前等级金额", () => {
    const desc = [
      { smallBlind: 10, bigBlind: 20, hands: 5 },
      { smallBlind: 5, bigBlind: 10, hands: 5 },
    ];
    expect(resolveBlindLevel(desc, 1)).toEqual({ smallBlind: 5, bigBlind: 10 });
  });
});

describe("nextTournamentDealer", () => {
  it("顺时针移动并跳过非参赛座位", () => {
    // 座位 0,2,5 参赛；dealer=2 → 下一参赛座位 5。
    expect(nextTournamentDealer(2, [0, 2, 5])).toBe(5);
    // dealer=5 → 回绕到 0。
    expect(nextTournamentDealer(5, [0, 2, 5])).toBe(0);
    // dealer=0 → 2。
    expect(nextTournamentDealer(0, [0, 2, 5])).toBe(2);
  });

  it("Heads-Up 在两名参赛者之间摆动", () => {
    expect(nextTournamentDealer(1, [1, 7])).toBe(7);
    expect(nextTournamentDealer(7, [1, 7])).toBe(1);
  });
});

describe("sortEliminationGroup", () => {
  it("手开始时 stack 较高者排名更高；相同则 seatIndex 升序", () => {
    expect(
      sortEliminationGroup([
        { seatIndex: 0, handStartChips: 100 },
        { seatIndex: 3, handStartChips: 150 },
        { seatIndex: 2, handStartChips: 150 },
        { seatIndex: 1, handStartChips: 50 },
      ]),
    ).toEqual([2, 3, 0, 1]); // 150 → seatIndex 升序 [2,3]；100 → [0]；50 → [1]
  });

  it("同 stack 按 seatIndex 稳定", () => {
    expect(
      sortEliminationGroup([
        { seatIndex: 5, handStartChips: 100 },
        { seatIndex: 1, handStartChips: 100 },
        { seatIndex: 3, handStartChips: 100 },
      ]),
    ).toEqual([1, 3, 5]);
  });
});
