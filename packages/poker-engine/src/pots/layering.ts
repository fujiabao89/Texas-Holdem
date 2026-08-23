/**
 * 底池分层与未跟注返还（TEX-14）。
 *
 * 结算模型：按每名玩家本手总投入（handContribution）**分层结算**，而非每次下注实时拆分（§9）。
 * 1. 迭代剥离：当「最大贡献唯一者」存在时，取其与**下一高 distinct 贡献层**之差退回该玩家，直到
 *    所有剩余贡献层无唯一最大者。**剥离只看金额分层、与是否 Fold 无关**（Fold 玩家同样退还未跟注部分）；
 *    只有 `eligiblePlayers` 判定才看 Fold。不得创建只有一名 contributor 的 Pot。
 * 2. 分层建池：自低层起 slab = level − prevLevel；contributors = 贡献≥level 的玩家（含 Fold）；
 *    eligiblePlayers = 未 Fold 且贡献≥level 的玩家；amount = slab × contributors 数。
 *
 * 权威规格：docs/01-engine-spec.md §9、§17。
 */
import type { Pot } from "../model/pot";

/** 参与分池的玩家最小信息。 */
export interface PotContributor {
  readonly seatIndex: number;
  /** 本手累计投入。 */
  readonly contribution: number;
  readonly folded: boolean;
}

export interface BuildPotsResult {
  readonly pots: readonly Pot[];
  readonly uncalledReturns: readonly { readonly seatIndex: number; readonly amount: number }[];
}

/** 按贡献分层构造 Main / Side Pot 并剥离未跟注顶层贡献。 */
export function buildPots(players: readonly PotContributor[]): BuildPotsResult {
  // 拷贝以便就地调整贡献（不改动入参）。
  const contrib: { seatIndex: number; contribution: number; folded: boolean }[] = players
    .filter((p) => p.contribution > 0)
    .map((p) => ({ seatIndex: p.seatIndex, contribution: p.contribution, folded: p.folded }));

  const uncalledReturns: { seatIndex: number; amount: number }[] = [];

  // 迭代剥离：唯一最大贡献者超出下一高 distinct 层的部分为未跟注，退回该玩家。
  // 循环每轮把该玩家降为「下一高 distinct 层」，可覆盖多层结构。
  for (;;) {
    const { max } = maxContribution(contrib);
    if (max === null) break;
    const holders = contrib.filter((p) => p.contribution === max);
    if (holders.length !== 1) break;
    const next = nextDistinctBelow(contrib, max);
    if (next === null || next >= max) break;
    const strip = max - next;
    holders[0]!.contribution = next;
    uncalledReturns.push({ seatIndex: holders[0]!.seatIndex, amount: strip });
  }

  // 自低层起建池（保证每层摊到 >=2 名贡献者，因唯一顶层已被剥离）。
  const levels = distinctAscending(contrib);
  const pots: Pot[] = [];
  let prev = 0;
  let index = 0;
  for (const level of levels) {
    const slab = level - prev;
    prev = level;
    if (slab <= 0) continue;
    const inLayer = contrib.filter((p) => p.contribution >= level);
    if (inLayer.length === 0) continue;
    // 防御：仅一名贡献者的层视作未跟注，退回（正常流程应在剥离阶段消除）。
    if (inLayer.length === 1) {
      uncalledReturns.push({ seatIndex: inLayer[0]!.seatIndex, amount: slab });
      continue;
    }
    const contributors = inLayer.map((p) => p.seatIndex);
    const eligiblePlayers = inLayer.filter((p) => !p.folded).map((p) => p.seatIndex);
    pots.push({ index: index++, amount: slab * inLayer.length, contributors, eligiblePlayers });
  }

  // 防御性兜底：无合格竞夺者的层并入主池（死钱归主池赢家），保证每池至少一名 eligible（§17）。
  const finalPots: Pot[] = [];
  for (const pot of pots) {
    if (pot.eligiblePlayers.length === 0) {
      if (finalPots.length === 0) {
        // 主池也无合格者（极端）：并入新建主池，交给唯一幸存者。正常流程不会出现。
        finalPots.push({
          index: 0,
          amount: pot.amount,
          contributors: pot.contributors,
          eligiblePlayers: [],
        });
      } else {
        const main = finalPots[0]!;
        finalPots[0] = { ...main, amount: main.amount + pot.amount };
      }
    } else {
      finalPots.push(pot);
    }
  }

  return {
    pots: Object.freeze(finalPots.map((p) => ({
      index: p.index,
      amount: p.amount,
      contributors: Object.freeze([...p.contributors]),
      eligiblePlayers: Object.freeze([...p.eligiblePlayers]),
    }))),
    uncalledReturns: Object.freeze(uncalledReturns),
  };
}

function maxContribution(
  players: readonly { contribution: number }[],
): { max: number | null } {
  let max = -1;
  for (const p of players) if (p.contribution > max) max = p.contribution;
  return { max: players.length === 0 ? null : max };
}

function nextDistinctBelow(
  players: readonly { contribution: number }[],
  threshold: number,
): number | null {
  let best: number | null = null;
  for (const p of players) {
    if (p.contribution < threshold && (best === null || p.contribution > best)) {
      best = p.contribution;
    }
  }
  return best;
}

function distinctAscending(
  players: readonly { contribution: number }[],
): readonly number[] {
  const set = new Set<number>();
  for (const p of players) if (p.contribution > 0) set.add(p.contribution);
  return [...set].sort((a, b) => a - b);
}
