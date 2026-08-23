/**
 * 单手状态机纯 reducer（TEX-14）。
 *
 * `createInitialState(config)`：选 Dealer、缴盲、发底牌、定首行动者；产出 HAND_STARTED / BLIND_POSTED /
 * DEAL_HOLE_CARD 事件。`reduceHand(state, action)`：校验并应用动作、推进街、处理提前结算与 Runout、
 * 比牌与分池结算。均为**确定性纯转移**：相同 config + action 序列恒产生相同 state + events（§16）。
 * 非法 Action 抛错且不改动原 state（保证「非法后状态/事件深度等价」可测）。
 *
 * 权威规格：docs/01-engine-spec.md §5–§11、§14、§16、§17。
 */
import type { Card } from "../cards";
import { Deck as StandardDeck, cardKey } from "../cards";
import type { GameState, HandConfig, HandOutcome, SeatConfig } from "../model/hand";
import type { PlayerState } from "../model/player";
import type { ParticipantKind } from "../model/type";
import type { Pot, PotAward } from "../model/pot";
import type { PlayerAction } from "../model/action";
import type { LegalActions } from "../model/legal";
import type { PokerEvent } from "../events/events";
import {
  computeBlinds,
  firstActor,
  nextActionableSeat,
  seatsClockwise,
  selectDealer,
} from "../rules/blinds";
import {
  anyPending,
  computeLegalActions,
  resolveAllIn,
  resolveBetOrRaise,
  resolveCall,
  updateAggression,
} from "../rules/betting";
import type { PlayerBetView } from "../rules/betting";
import { burnAndDeal, nextStreet } from "../rules/street";
import { buildPots } from "../pots/layering";
import { settlePots } from "../pots/settlement";

const EMPTY_STREET_AGG = { currentBet: 0, hasFullBetOrRaise: false } as const;

/** 引擎内部可变工作副本（最终冻结为 PlayerState 对外）。 */
type MutableSeat = {
  seatIndex: number;
  name: string;
  kind: ParticipantKind;
  chips: number;
  holeCards: Card[];
  streetBet: number;
  handContribution: number;
  folded: boolean;
  isAllIn: boolean;
  hasActedThisStreet: boolean;
  lastDecisionBet: number;
  lastDecisionRaiseSize: number;
};

function toMutableSeats(seats: readonly PlayerState[]): MutableSeat[] {
  return seats.map((p): MutableSeat => ({ ...p, holeCards: [...p.holeCards] }));
}

function freezeSeats(seats: readonly MutableSeat[]): readonly PlayerState[] {
  return Object.freeze(seats.map((s) => Object.freeze({ ...s })));
}

export interface HandResult {
  readonly state: GameState;
  readonly events: readonly PokerEvent[];
}

/** 校验开局配置边界（§16 确定性 / §12 约束）：≥2 名持筹码玩家、座位号唯一、dealer 在参与集合、注入牌堆足够且唯一、SB < BB。 */
function validateHandConfig(config: HandConfig, inHand: readonly SeatConfig[]): void {
  // 金额校验：盲注为正整数、参与筹码为非负整数（拒绝负数/小数/非有限值，§4.3/§8.6）。
  if (!Number.isInteger(config.smallBlind) || config.smallBlind <= 0) {
    throw new Error(`createInitialState: 小盲必须为正整数，收到 ${config.smallBlind}`);
  }
  if (!Number.isInteger(config.bigBlind) || config.bigBlind <= 0) {
    throw new Error(`createInitialState: 大盲必须为正整数，收到 ${config.bigBlind}`);
  }
  for (const s of config.seats) {
    if (!Number.isInteger(s.chips) || s.chips < 0) {
      throw new Error(`createInitialState: 座位 ${s.seatIndex} 筹码必须为非负整数，收到 ${s.chips}`);
    }
  }
  if (inHand.length < 2 || inHand.length > 10) {
    throw new Error(`createInitialState: 本手需 2–10 名持筹码玩家，实际 ${inHand.length}`);
  }
  const seen = new Set<number>();
  for (const s of config.seats) {
    if (seen.has(s.seatIndex)) throw new Error(`createInitialState: 座位号 ${s.seatIndex} 重复`);
    seen.add(s.seatIndex);
  }
  if (config.dealerSeat !== undefined && !inHand.some((s) => s.seatIndex === config.dealerSeat)) {
    throw new Error(`createInitialState: dealerSeat ${config.dealerSeat} 不在参与座位中`);
  }
  if (config.smallBlind >= config.bigBlind) {
    throw new Error(`createInitialState: 小盲 ${config.smallBlind} 必须小于大盲 ${config.bigBlind}`);
  }
  // 注入牌堆契约：恰好 52 张唯一牌（与 §17 牌堆守恒不变量一致）；拒绝部分前缀，避免构造后 assertInvariants 再报错。
  if (config.deck) {
    const cards = config.deck.toArray();
    if (cards.length !== 52) {
      throw new Error(`createInitialState: 注入牌堆须为恰好 52 张（收到 ${cards.length} 张）`);
    }
    if (new Set(cards.map(cardKey)).size !== cards.length) {
      throw new Error("createInitialState: 注入牌堆含重复牌");
    }
  }
}

/** 构造开局状态并产出开局事件。 */
export function createInitialState(config: HandConfig): HandResult {
  const seq = { value: 0 };
  const events: PokerEvent[] = [];
  const emit = <T extends Omit<PokerEvent, "sequence">>(e: T) => {
    events.push(Object.freeze({ ...e, sequence: seq.value++ }) as unknown as PokerEvent);
  };

  // 排除零筹码座位（本手参与集合，见 §4.3；不清除牌局中途全下者），并校验开局边界（§12 / §16）。
  const inHand = config.seats.filter((s) => s.chips > 0);
  validateHandConfig(config, inHand);

  const seats: MutableSeat[] = inHand.map((s) => ({
    seatIndex: s.seatIndex,
    name: s.name,
    kind: s.kind,
    chips: s.chips,
    holeCards: [],
    streetBet: 0,
    handContribution: 0,
    folded: false,
    isAllIn: false,
    hasActedThisStreet: false,
    lastDecisionBet: 0,
    lastDecisionRaiseSize: config.bigBlind,
  }));

  const dealerSeat = selectDealer(inHand, config.rng, config.dealerSeat);
  const { sbSeat, bbSeat } = computeBlinds(inHand, dealerSeat);
  const initialTotalChips = inHand.reduce((sum, s) => sum + s.chips, 0);

  // 牌堆：注入 deck 用之（不洗）；否则标准 52 张按 rng 洗牌（洗牌顺序写入 state）。
  let remainingDeck: Card[];
  if (config.deck) {
    remainingDeck = [...config.deck.toArray()];
  } else {
    const d = new StandardDeck();
    d.shuffle(config.rng);
    remainingDeck = d.toArray();
  }

  emit({
    type: "HAND_STARTED",
    handNumber: config.handNumber,
    dealerSeat,
    sbSeat,
    bbSeat,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    seats: Object.freeze(inHand.map((s) => Object.freeze({ seatIndex: s.seatIndex, name: s.name, kind: s.kind, chips: s.chips }))),
  });

  // 缴盲：SB / BB（不足则全下；当前跟注额 = 实际 BB 投入，决定 hasFullBetOrRaise）。
  [sbSeat, bbSeat].forEach((seat, i) => {
    const blind = i === 0 ? config.smallBlind : config.bigBlind;
    const player = seats.find((s) => s.seatIndex === seat)!;
    const amount = Math.min(blind, player.chips);
    player.chips -= amount;
    player.streetBet += amount;
    player.handContribution += amount;
    player.isAllIn = player.chips === 0;
    emit({
      type: "BLIND_POSTED",
      seatIndex: seat,
      blind: i === 0 ? "small" : "big",
      amount,
      toAmount: player.streetBet,
    });
  });
  // §8.2：Pre-Flop 初始下注上下文为**完整默认 BB 态**——currentBet / lastFullRaiseSize = 名义 BB，
  // hasFullBetOrRaise = true（即使 BB 玩家短盲/低于 BB，也不降低 minRaiseTo；短盲部分在结算时作为未跟注返还，§9）。
  // blind 事件仍记录实际投入额（§14）。

  // 发底牌：两轮，每轮从 Dealer 左侧起顺时针（HU 时 Button/SB 先得第一张）。
  const indices = seats.map((s) => s.seatIndex);
  const dealOrder =
    indices.length === 2
      ? [dealerSeat, ...indices.filter((s) => s !== dealerSeat)]
      : seatsClockwise(indices, dealerSeat);
  for (let round = 1; round <= 2; round++) {
    for (const seat of dealOrder) {
      const card = remainingDeck.shift()!;
      const player = seats.find((s) => s.seatIndex === seat)!;
      player.holeCards = [...player.holeCards, card];
      emit({
        type: "DEAL_HOLE_CARD",
        seatIndex: seat,
        card,
        holeNumber: round as 1 | 2,
      });
    }
  }

  // 首行动者可能因短盲全下（chips==0）而不可行动：跳至下一可行动座位；全部不可行动（全员全下）则置 null。
  const firstActorSeat = firstActor(inHand, dealerSeat, "preflop");
  const isActionable = (seatIndex: number): boolean => {
    const p = seats.find((s) => s.seatIndex === seatIndex)!;
    return !p.isAllIn && !p.folded;
  };
  const currentActor = isActionable(firstActorSeat)
    ? firstActorSeat
    : nextActionableSeat(seats.map((s) => s.seatIndex), firstActorSeat, isActionable);

  let state: GameState = Object.freeze({
    handNumber: config.handNumber,
    phase: "preflop",
    street: "preflop",
    seats: freezeSeats(seats),
    communityCards: Object.freeze([]),
    burnCards: Object.freeze([]),
    remainingDeck: Object.freeze([...remainingDeck]),
    dealerSeat,
    sbSeat,
    bbSeat,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    currentActor,
    currentBet: config.bigBlind,
    lastFullRaiseSize: config.bigBlind,
    hasFullBetOrRaise: true,
    pots: Object.freeze([]),
    nextSequence: seq.value,
    initialTotalChips,
    outcome: null,
  });

  // 全员全下（含 HU 短盲）：无可行动者 → 立即 Runout + 比牌结算（§6 提前结算 2）。
  if (currentActor === null) {
    state = runToSettlement(state, emit);
    // 回写自动推进（BURN/deal/showdown/award 等）产生的最终 sequence 游标，避免事件序号复用（§14/§16）。
    state = Object.freeze({ ...state, nextSequence: seq.value });
  }

  return { state, events: Object.freeze(events) };
}

/** 校验并应用一个动作；非法则抛错（不产生新 state）。 */
export function reduceHand(state: GameState, action: PlayerAction): HandResult {
  validateAction(state, action);
  const legal = legalForSeat(state, action.seatIndex);

  const seq = { value: state.nextSequence };
  const events: PokerEvent[] = [];
  const emit = <T extends Omit<PokerEvent, "sequence">>(e: T) => {
    events.push(Object.freeze({ ...e, sequence: seq.value++ }) as unknown as PokerEvent);
  };

  const seats = toMutableSeats(state.seats);
  const actor = seats.find((s) => s.seatIndex === action.seatIndex)!;

  let currentBet = state.currentBet;
  let lastFullRaiseSize = state.lastFullRaiseSize;
  let hasFullBetOrRaise = state.hasFullBetOrRaise;

  const applyPlayer = (
    amount: number,
    newStreetBet: number,
    newChips: number,
    isAllIn: boolean,
  ) => {
    actor.chips = newChips;
    actor.streetBet = newStreetBet;
    actor.handContribution += amount;
    actor.isAllIn = isAllIn;
    actor.hasActedThisStreet = true;
  };

  switch (action.type) {
    case "fold": {
      actor.folded = true;
      actor.hasActedThisStreet = true;
      emit({
        type: "PLAYER_FOLDED",
        seatIndex: action.seatIndex,
        source: action.source,
        amount: 0,
        toAmount: actor.streetBet,
      });
      break;
    }
    case "check": {
      if (legal.callAmount !== 0) throw new Error("不能过牌：有待跟注");
      applyPlayer(0, actor.streetBet, actor.chips, actor.isAllIn);
      emit({ type: "PLAYER_CHECKED", seatIndex: action.seatIndex, source: action.source, amount: 0, toAmount: actor.streetBet });
      break;
    }
    case "call": {
      const mv = resolveCall(actor, legal.callAmount);
      applyPlayer(mv.amount, mv.newStreetBet, mv.newChips, mv.isAllIn);
      emit({ type: "PLAYER_CALLED", seatIndex: action.seatIndex, source: action.source, amount: mv.amount, toAmount: mv.newStreetBet });
      break;
    }
    case "bet": {
      const target = action.amount!;
      const mv = resolveBetOrRaise(actor, target);
      applyPlayer(mv.amount, mv.newStreetBet, mv.newChips, mv.isAllIn);
      const agg = updateAggression({ prevCurrentBet: state.currentBet, target, bigBlind: state.bigBlind, hasFullBetOrRaise });
      currentBet = agg.currentBet;
      lastFullRaiseSize = agg.lastFullRaiseSize;
      hasFullBetOrRaise = agg.hasFullBetOrRaise;
      emit({ type: "PLAYER_BET", seatIndex: action.seatIndex, source: action.source, amount: mv.amount, toAmount: mv.newStreetBet });
      break;
    }
    case "raise": {
      const target = action.amount!;
      const mv = resolveBetOrRaise(actor, target);
      applyPlayer(mv.amount, mv.newStreetBet, mv.newChips, mv.isAllIn);
      const agg = updateAggression({ prevCurrentBet: state.currentBet, target, bigBlind: state.bigBlind, hasFullBetOrRaise });
      currentBet = agg.currentBet;
      lastFullRaiseSize = agg.lastFullRaiseSize;
      hasFullBetOrRaise = agg.hasFullBetOrRaise;
      emit({ type: "PLAYER_RAISED", seatIndex: action.seatIndex, source: action.source, amount: mv.amount, toAmount: mv.newStreetBet });
      break;
    }
    case "all-in": {
      const mv = resolveAllIn(actor);
      applyPlayer(mv.amount, mv.newStreetBet, mv.newChips, mv.isAllIn);
      if (mv.newStreetBet > state.currentBet) {
        const minRaiseTo = hasFullBetOrRaise ? state.currentBet + lastFullRaiseSize : state.bigBlind;
        if (mv.newStreetBet >= minRaiseTo) {
          const agg = updateAggression({ prevCurrentBet: state.currentBet, target: mv.newStreetBet, bigBlind: state.bigBlind, hasFullBetOrRaise });
          currentBet = agg.currentBet;
          lastFullRaiseSize = agg.lastFullRaiseSize;
          hasFullBetOrRaise = agg.hasFullBetOrRaise;
        } else {
          currentBet = mv.newStreetBet; // Short all-in：不重置完整加注基准
        }
      }
      emit({ type: "PLAYER_ALL_IN", seatIndex: action.seatIndex, source: action.source, amount: mv.amount, toAmount: mv.newStreetBet });
      break;
    }
  }

  // 记录本次动作后的下注权重开基线（§8.3）：以动作后的 currentBet / lastFullRaiseSize 为准。
  actor.lastDecisionBet = currentBet;
  actor.lastDecisionRaiseSize = lastFullRaiseSize;

  const next: GameState = Object.freeze({
    ...state,
    seats: freezeSeats(seats),
    currentBet,
    lastFullRaiseSize,
    hasFullBetOrRaise,
    nextSequence: seq.value,
  });

  const result = advanceAfterAction(next, emit);
  // 回写自动推进（BURN/deal/showdown/award 等）产生的最终 sequence 游标，保证事件序号唯一且单调（§14/§16）。
  return { state: Object.freeze({ ...result, nextSequence: seq.value }), events: Object.freeze(events) };
}

/** 动作后推进：提前结算 / Runout / 同街下一行动者 / 下一街或比牌。 */
function advanceAfterAction(
  state: GameState,
  emit: <T extends Omit<PokerEvent, "sequence">>(e: T) => void,
): GameState {
  const remaining = state.seats.filter((s) => !s.folded);

  // ① 仅剩一名未 Fold → 直接结算。
  if (remaining.length <= 1) {
    return settle(state, false, emit);
  }
  // ② 所有剩余玩家均已 All-in → 自动补足剩余公共牌并结算。
  if (remaining.every((s) => s.isAllIn)) {
    return runToSettlement(state, emit);
  }
  // ③ 仍有人待行动 → 同街推进到下一行动者。
  if (anyPending(state.seats, state.currentBet)) {
    const nextActor = nextActionableSeat(
      state.seats.map((s) => s.seatIndex),
      state.currentActor ?? state.dealerSeat,
      (seat) => {
        const ps = state.seats.find((s) => s.seatIndex === seat)!;
        return !ps.folded && !ps.isAllIn && (ps.streetBet < state.currentBet || !ps.hasActedThisStreet);
      },
    );
    return Object.freeze({ ...state, currentActor: nextActor });
  }
  // ④ 本街结束：river 之后进入比牌，否则推进下一街。
  const nextStreetValue = nextStreet(state.street);
  if (nextStreetValue === null) {
    return settle(state, true, emit);
  }
  return dealNextStreetIfPossible(state, emit);
}

/** 推进到下一街（烧 1 张 + 发公共牌），重置下注基准与行动者。 */
function dealNextStreetIfPossible(
  state: GameState,
  emit: <T extends Omit<PokerEvent, "sequence">>(e: T) => void,
): GameState {
  const nextStreetValue = nextStreet(state.street)!;
  const { burn, cards, remaining } = burnAndDeal([...state.remainingDeck], nextStreetValue);
  const deck = remaining;
  const communityCards = [...state.communityCards, ...cards];
  const burnCards = [...state.burnCards, burn];
  // Post-Flop 首行动者：Dealer 左侧第一个仍可行动者（跳过弃牌/全下；HU 为 BB）。全下场景由 advanceAfterAction 的 Runout 分支前置处理。
  const nextActor = nextActionableSeat(
    state.seats.map((s) => s.seatIndex),
    state.dealerSeat,
    (seat) => {
      const p = state.seats.find((s) => s.seatIndex === seat)!;
      return !p.folded && !p.isAllIn;
    },
  );
  const seats = toMutableSeats(state.seats).map((p) => ({
    ...p,
    streetBet: 0,
    hasActedThisStreet: false,
    lastDecisionBet: 0,
    lastDecisionRaiseSize: state.bigBlind,
  }));
  emit({ type: "BURN_CARD", street: nextStreetValue });
  if (nextStreetValue === "flop") emit({ type: "FLOP_DEALT", cards: Object.freeze([...cards]) });
  else if (nextStreetValue === "turn") emit({ type: "TURN_DEALT", card: cards[0]! });
  else emit({ type: "RIVER_DEALT", card: cards[0]! });
  return Object.freeze({
    ...state,
    phase: nextStreetValue,
    street: nextStreetValue,
    seats: freezeSeats(seats),
    communityCards: Object.freeze(communityCards),
    burnCards: Object.freeze(burnCards),
    remainingDeck: Object.freeze(deck),
    currentActor: nextActor,
    currentBet: EMPTY_STREET_AGG.currentBet,
    lastFullRaiseSize: state.bigBlind,
    hasFullBetOrRaise: false,
  });
}

/** 全员 All-in：自动补足剩余公共牌至 river 并比牌结算（§6 提前结算 2 / §8.5）。 */
function runToSettlement(
  state: GameState,
  emit: <T extends Omit<PokerEvent, "sequence">>(e: T) => void,
): GameState {
  let s = state;
  while (s.communityCards.length < 5) {
    s = dealNextStreetIfPossible(s, emit);
  }
  return settle(s, true, emit);
}

/** 比牌 / 提前结算，产出 POT_AWARDED / UNCALLED_BET_RETURNED / SHOWDOWN / REVEALED。 */
function settle(
  state: GameState,
  showdown: boolean,
  emit: <T extends Omit<PokerEvent, "sequence">>(e: T) => void,
): GameState {
  const remaining = state.seats.filter((s) => !s.folded);
  const board = state.communityCards;

  if (showdown) {
    emit({ type: "SHOWDOWN_STARTED", communityCards: Object.freeze([...board]), remainingPlayers: Object.freeze(remaining.map((s) => s.seatIndex)) });
    // 仅比牌才揭示底牌；弃牌胜出（showdown=false）不翻牌（§14）。
    for (const p of remaining) {
      emit({ type: "PLAYER_REVEALED", seatIndex: p.seatIndex, cards: Object.freeze([...p.holeCards]) });
    }
  }

  // 构造底池 + 未跟注返还。
  const { pots, uncalledReturns } = buildPots(
    state.seats.map((s) => ({ seatIndex: s.seatIndex, contribution: s.handContribution, folded: s.folded })),
  );
  for (const ret of uncalledReturns) {
    emit({ type: "UNCALLED_BET_RETURNED", seatIndex: ret.seatIndex, amount: ret.amount });
  }
  const seats = toMutableSeats(state.seats);
  for (const ret of uncalledReturns) {
    const p = seats.find((s) => s.seatIndex === ret.seatIndex)!;
    p.chips += ret.amount;
    p.handContribution = Math.max(0, p.handContribution - ret.amount);
  }

  // 提前结算：仅剩一名未 Fold。
  if (remaining.length <= 1) {
    const winner = remaining[0] ?? null;
    const awards: PotAward[] = [];
    if (winner) {
      for (const pot of pots) {
        const award: PotAward = {
          potIndex: pot.index,
          totalAmount: pot.amount,
          winners: Object.freeze([winner.seatIndex]),
          prizeBySeat: Object.freeze({ [winner.seatIndex]: pot.amount }),
          eligiblePlayers: Object.freeze([...pot.eligiblePlayers]),
        };
        awards.push(award);
        emit({ type: "POT_AWARDED", potIndex: pot.index, amount: pot.amount, winners: award.winners, prizeBySeat: award.prizeBySeat, eligiblePlayers: award.eligiblePlayers });
        const pw = seats.find((s) => s.seatIndex === winner.seatIndex)!;
        pw.chips += pot.amount;
      }
    }
    const outcome = makeOutcome(state, board, pots, awards, uncalledReturns, winner ? [winner.seatIndex] : [], false);
    return Object.freeze({ ...state, seats: Object.freeze(seats.map((s) => Object.freeze({ ...s }))), currentActor: null, phase: "hand_end", outcome, pots: Object.freeze(pots) });
  }

  // 比牌：每 Pot 独立（Showdown 已发到 5 张公共牌）。
  const awards = settlePots(pots, seats, board, state.dealerSeat);
  for (const award of awards) {
    for (const [seatStr, prize] of Object.entries(award.prizeBySeat)) {
      const p = seats.find((s) => s.seatIndex === Number(seatStr))!;
      p.chips += prize;
    }
    emit({ type: "POT_AWARDED", potIndex: award.potIndex, amount: award.totalAmount, winners: award.winners, prizeBySeat: award.prizeBySeat, eligiblePlayers: award.eligiblePlayers });
  }
  const winners = awards.flatMap((a) => a.winners);
  const outcome = makeOutcome(state, board, pots, awards, uncalledReturns, winners, true);
  return Object.freeze({ ...state, seats: Object.freeze(seats.map((s) => Object.freeze({ ...s }))), currentActor: null, phase: "hand_end", outcome, pots: Object.freeze(pots) });
}

function makeOutcome(
  state: GameState,
  board: readonly Card[],
  pots: readonly Pot[],
  awards: readonly PotAward[],
  uncalledReturns: readonly { seatIndex: number; amount: number }[],
  winners: readonly number[],
  showdown: boolean,
): HandOutcome {
  return {
    handNumber: state.handNumber,
    board: Object.freeze([...board]),
    pots: Object.freeze([...pots]),
    awards: Object.freeze([...awards]),
    uncalledReturns: Object.freeze([...uncalledReturns]),
    winners: Object.freeze([...new Set(winners)]),
    showdown,
  };
}

/** 校验动作：当前行动者、阶段、类型合法、金额合法（整数/范围）。非法则抛错。 */
function validateAction(state: GameState, action: PlayerAction): void {
  if (state.phase !== state.street || state.currentActor === null) {
    throw new Error("validateAction: 当前不在下注阶段");
  }
  if (action.seatIndex !== state.currentActor) {
    throw new Error(`validateAction: 非当前行动者（actor=${state.currentActor}，收到 ${action.seatIndex}）`);
  }
  const player = state.seats.find((s) => s.seatIndex === action.seatIndex)!;
  if (!player || player.folded || player.isAllIn) {
    throw new Error("validateAction: 该玩家已弃牌或已全下");
  }
  const legal = legalForSeat(state, action.seatIndex);
  switch (action.type) {
    case "fold":
      if (!legal.canFold) throw new Error("validateAction: 不能弃牌");
      break;
    case "check":
      if (!legal.canCheck) throw new Error("validateAction: 不能过牌");
      break;
    case "call":
      if (!legal.canCall) throw new Error("validateAction: 不能跟注");
      break;
    case "bet":
      if (!legal.canBet) throw new Error("validateAction: 不能下注");
      assertAmount(action.amount, "bet");
      if (action.amount! < legal.minBetTo!) throw new Error("validateAction: 低于最小下注");
      if (action.amount! > legal.maxRaiseTo) throw new Error("validateAction: 超过最大下注");
      break;
    case "raise":
      if (!legal.canRaise) throw new Error("validateAction: 不能加注");
      assertAmount(action.amount, "raise");
      if (action.amount! < legal.minRaiseTo!) throw new Error("validateAction: 低于最小加注");
      if (action.amount! > legal.maxRaiseTo) throw new Error("validateAction: 超过最大加注");
      break;
    case "all-in":
      if (!legal.canAllIn) throw new Error("validateAction: 不能全下");
      break;
    default: {
      // 保留编译期穷尽校验；运行时未知 type 必须拒绝（不可据以推进状态机）。
      const _exhaustive: never = action.type;
      void _exhaustive;
      throw new Error(`validateAction: 未知动作类型 ${String(action.type)}`);
    }
  }
}

function assertAmount(amount: number | undefined, kind: string): void {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new Error(`validateAction: ${kind} 金额必须是合法非负整数，收到 ${amount}`);
  }
}

/** 计算某座位的 LegalActions（供校验与 getLegalActions 复用）。 */
export function legalForSeat(state: GameState, seatIndex: number): LegalActions {
  return computeLegalActions(
    {
      currentBet: state.currentBet,
      lastFullRaiseSize: state.lastFullRaiseSize,
      hasFullBetOrRaise: state.hasFullBetOrRaise,
      bigBlind: state.bigBlind,
    },
    betViewForSeat(state, seatIndex),
  );
}

function betViewForSeat(state: GameState, seatIndex: number): PlayerBetView {
  const p = state.seats.find((s) => s.seatIndex === seatIndex);
  if (!p) throw new Error(`betViewForSeat: 无座位 ${seatIndex}`);
  return {
    streetBet: p.streetBet,
    chips: p.chips,
    hasActedThisStreet: p.hasActedThisStreet,
    lastDecisionBet: p.lastDecisionBet,
    lastDecisionRaiseSize: p.lastDecisionRaiseSize,
  };
}
