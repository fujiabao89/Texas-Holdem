/**
 * 下注规则（TEX-14）。
 *
 * 纯函数：LegalActions 计算、pending 判定、加注权重开、`lastFullRaiseSize`/`hasFullBetOrRaise` 更新
 * 与各类下注的筹码移动。状态机（engine/state-machine.ts）据此编排；本模块不 import engine。
 *
 * 权威规格：docs/01-engine-spec.md §5.2、§8.2–§8.6。
 */
import type { LegalActions } from "../model/legal";

/** 下注上下文（每街）。preflop 初始 currentBet=BB、lastFullRaiseSize=BB；postflop currentBet=0、lastFullRaiseSize=BB。 */
export interface BettingContext {
  readonly currentBet: number;
  readonly lastFullRaiseSize: number;
  /** 本街是否已出现首笔完整 Bet/Raise（决定 minRaiseTo 是否回落到 BB）。 */
  readonly hasFullBetOrRaise: boolean;
  readonly bigBlind: number;
}
/** 计算合法动作所需的玩家视图（streetBet / chips / 权重开记录）。 */
export interface PlayerBetView {
  readonly streetBet: number;
  readonly chips: number;
  readonly hasActedThisStreet: boolean;
  readonly lastDecisionBet: number;
  readonly lastDecisionRaiseSize: number;
}

/** 计算 LegalActions（§5.2）。 */
export function computeLegalActions(
  ctx: BettingContext,
  player: PlayerBetView,
): LegalActions {
  const { currentBet, bigBlind } = ctx;
  const callAmount = Math.max(0, currentBet - player.streetBet);
  const allInTo = player.streetBet + player.chips;
  const canCheck = callAmount === 0;
  const canCall = callAmount > 0 && player.chips >= callAmount;
  // 加注权重开：未行动者保有完整权；已行动者仅当自上次决定累计增量达上次完整加注幅度才重开（§8.3）。
  const reopens =
    !player.hasActedThisStreet ||
    currentBet - player.lastDecisionBet >= player.lastDecisionRaiseSize;
  const minRaiseTo = ctx.hasFullBetOrRaise ? currentBet + ctx.lastFullRaiseSize : bigBlind;
  const canBet = currentBet === 0 && allInTo >= bigBlind;
  const canRaise = currentBet > 0 && reopens && allInTo >= minRaiseTo;
  const canAllIn = player.chips > 0 && allInTo !== currentBet;

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet,
    minBetTo: canBet ? bigBlind : null,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : null,
    maxRaiseTo: allInTo,
    canAllIn,
    allInTo,
  };
}

/** 该玩家是否仍有待行动（未 fold、未 all-in，且尚未满足当前下注 / 尚未行动过）。 */
export function isPending(
  player: PlayerBetView & { folded: boolean; isAllIn: boolean },
  currentBet: number,
): boolean {
  if (player.folded || player.isAllIn) return false;
  return player.streetBet < currentBet || !player.hasActedThisStreet;
}

/** 是否不存在任何待行动玩家。 */
export function anyPending(
  players: readonly (PlayerBetView & { folded: boolean; isAllIn: boolean })[],
  currentBet: number,
): boolean {
  return players.some((p) => isPending(p, currentBet));
}

/** 首笔完整开注 / 后续完整加注时的 `currentBet`、`lastFullRaiseSize` 与 `hasFullBetOrRaise` 更新。 */
export function updateAggression(opts: {
  readonly prevCurrentBet: number;
  readonly target: number;
  readonly bigBlind: number;
  readonly hasFullBetOrRaise: boolean;
}): {
  readonly currentBet: number;
  readonly lastFullRaiseSize: number;
  readonly hasFullBetOrRaise: boolean;
} {
  const { prevCurrentBet, target, bigBlind, hasFullBetOrRaise } = opts;
  if (!hasFullBetOrRaise) {
    // 首笔完整开注：若先前的 currentBet 来自低于 BB 的 short all-in，则完整加注基准取 BB；否则取 target − prev（首 bet）。
    const isShort = prevCurrentBet > 0 && prevCurrentBet < bigBlind;
    return {
      currentBet: target,
      lastFullRaiseSize: isShort ? bigBlind : target - prevCurrentBet,
      hasFullBetOrRaise: true,
    };
  }
  return {
    currentBet: target,
    lastFullRaiseSize: target - prevCurrentBet,
    hasFullBetOrRaise: true,
  };
}

/** 一次跟注的筹码移动（含 Short Call All-in：chips < callAmount 时全下）。 */
export function resolveCall(
  player: PlayerBetView,
  callAmount: number,
): {
  readonly amount: number;
  readonly newStreetBet: number;
  readonly newChips: number;
  readonly isAllIn: boolean;
} {
  const amount = Math.min(callAmount, player.chips);
  const newChips = player.chips - amount;
  return { amount, newStreetBet: player.streetBet + amount, newChips, isAllIn: newChips === 0 };
}

/** 一次下注/加注（target = 本街目标总投入）后的筹码移动。 */
export function resolveBetOrRaise(
  player: PlayerBetView,
  target: number,
): {
  readonly amount: number;
  readonly newStreetBet: number;
  readonly newChips: number;
  readonly isAllIn: boolean;
} {
  const amount = target - player.streetBet;
  const newChips = player.chips - amount;
  return { amount, newStreetBet: target, newChips, isAllIn: newChips === 0 };
}

/** 一次全下的筹码移动：投入全部剩余筹码，streetBet 变为 allInTo。 */
export function resolveAllIn(
  player: PlayerBetView,
): {
  readonly amount: number;
  readonly newStreetBet: number;
  readonly newChips: number;
  readonly isAllIn: boolean;
} {
  const amount = player.chips;
  return { amount, newStreetBet: player.streetBet + amount, newChips: 0, isAllIn: true };
}
