/**
 * 单场锦标赛 Headless 运行器（TEX-16）。
 *
 * 从 seed 确定性派生：场景（generateScenario）、引擎随机源（SeededRandomSource）与
 * 代理随机流，驱动 `TournamentEngine` 走到唯一 Champion。每次状态转移后与每手结束后
 * 断言全部引擎不变量与事件序列完整性；Watchdog 监控 Liveness（docs/06 §5）。
 *
 * 确定性：同 seed 恒得同一场景、同一动作序列、同一事件流（100% 可重放，docs/01 §16）。
 * 本模块不修改引擎规则；引擎抛出的任何错误都保留现场并转为失败报告。
 */
import {
  TournamentEngine,
  SeededRandomSource,
  evaluateHand,
  handRankName,
} from "../../../packages/poker-engine/src/index";
import type {
  LegalActions,
  GameState,
  PlayerAction,
  ActionType,
  BlindMode,
  PokerEvent,
  Street,
  TournamentState,
} from "../../../packages/poker-engine/src/index";
import { createSeededRandom, deriveSeed } from "../../support/random";
import { generateScenario } from "../random-hands/scenario";
import type { SimulatorScenario } from "../random-hands/scenario";
import { chooseAction } from "../random-hands/agent";
import {
  assertTournamentStateInvariants,
  createEventSequenceChecker,
} from "../invariants/invariant-checks";
import { createWatchdog, WatchdogFailure } from "./watchdog";
import type { WatchdogThresholds } from "./watchdog";
import { SimulationFailure } from "./failure";
import type { RecordedAction, SimulationFailureCategory } from "./failure";
import type { HandRecord, TournamentRecord } from "./stats";

export interface TournamentRunResult extends TournamentRecord {
  readonly elapsedMs: number;
}

/**
 * Short All-in 分类（仅统计用途，不裁决合法性）。
 * 语义对齐 docs/01 §5.2：`allInTo` 为本街**目标总投入**，须与同为总额的 `currentBet`
 * 比较（不得与增量语义的 `callAmount` 直接比较——`streetBet>0` 时两者不可比）。
 * - Short Call All-in（§8.4）：`allInTo < currentBet`（全下不足以至跟注）。
 * - Short Raise All-in（§8.3）：`currentBet < allInTo < fullRaiseTo`（超过跟注但不足完整加注）。
 * - Short Bet 开注：`currentBet = 0` 且 `allInTo < bigBlind`（低于 BB 的全下开注）。
 * 注：Engine 的 `canAllIn` 保证 all-in 动作 `allInTo !== currentBet`，两分支完整覆盖。
 */
export function isShortAllIn(hand: GameState, legal: LegalActions): boolean {
  if (hand.currentBet > 0) {
    if (legal.allInTo < hand.currentBet) return true;
    const fullRaiseTo = hand.hasFullBetOrRaise
      ? hand.currentBet + hand.lastFullRaiseSize
      : hand.bigBlind;
    return legal.allInTo > hand.currentBet && legal.allInTo < fullRaiseTo;
  }
  return legal.allInTo < hand.bigBlind;
}

export interface RunTournamentOptions {
  /** Watchdog 阈值（默认 docs/06 §5 规格值）。 */
  readonly thresholds?: WatchdogThresholds;
  /** 时间函数（测试注入假时钟；不得使用 sleep）。 */
  readonly now?: () => number;
  /** 失败时提取统计摘要（批量运行时由调用方提供）。 */
  readonly statsSummary?: () => Record<string, number>;
  /** 强制场景 Blind Mode（Nightly 逐模式下限，docs/06 §5）；缺省由加权随机选择。 */
  readonly blindMode?: BlindMode;
}

/** 由 seed 派生单场锦标赛的确定性场景。 */
export function scenarioForSeed(seed: number, forcedBlindMode?: BlindMode): SimulatorScenario {
  return generateScenario(createSeededRandom(deriveSeed(seed, "scenario")), forcedBlindMode);
}

export function runTournament(seed: number, options: RunTournamentOptions = {}): TournamentRunResult {
  const now = options.now ?? (() => performance.now());
  const scenario = scenarioForSeed(seed, options.blindMode);
  const engineRng = new SeededRandomSource(deriveSeed(seed, "engine"));
  const agentRng = createSeededRandom(deriveSeed(seed, "agent"));
  const participants = Array.from({ length: scenario.playerCount }, (_, i) => ({
    seatIndex: i,
    name: `P${i}`,
    kind: "human" as const,
  }));

  const engine = new TournamentEngine(
    {
      maxPlayers: scenario.playerCount,
      startingStack: scenario.startingStack,
      smallBlind: scenario.smallBlind,
      bigBlind: scenario.bigBlind,
      blindMode: scenario.blindMode,
      blindStructure: scenario.blindStructure,
    },
    engineRng,
    participants,
  );

  const watchdog = createWatchdog(options.thresholds, now);
  const eventChecker = createEventSequenceChecker();
  const actions: RecordedAction[] = [];
  const hands: HandRecord[] = [];
  let actionsTaken = 0;
  let headsUpReached = false;
  let trackedHandNumber = 0;
  let recordedHandNumber = 0;
  let currentActionCounts: Partial<Record<ActionType, number>> = {};
  let currentShortAllIns = 0;
  const startedAt = now();

  /** 每次状态转移后的统一检查：事件序列 → 不变量 → 手结束记录 → Watchdog。 */
  function afterTransition(): void {
    const state = engine.getState();
    eventChecker.observe(engine.getEvents());
    assertTournamentStateInvariants(state);

    // 新手检测不能依赖 handInProgress：一手可能在 startNextHand() 内即时完成
    // （如浅筹码盲注全下自动 runout），此时仍须重置 per-hand 统计并检测 Heads-Up。
    if (state.hand && state.hand.handNumber !== trackedHandNumber) {
      trackedHandNumber = state.hand.handNumber;
      currentActionCounts = {};
      currentShortAllIns = 0;
      if (state.participants.filter((p) => p.status === "ACTIVE").length === 2) {
        headsUpReached = true;
      }
    }

    if (
      !state.handInProgress &&
      state.hand &&
      state.hand.phase === "hand_end" &&
      state.hand.handNumber !== recordedHandNumber
    ) {
      recordedHandNumber = state.hand.handNumber;
      hands.push(buildHandRecord(state.hand, scenario));
      watchdog.noteHandCompleted();
    }

    watchdog.check();
  }

  function buildHandRecord(hand: GameState, scenario2: SimulatorScenario): HandRecord {
    const outcome = hand.outcome;
    if (!outcome) {
      throw new Error(`hand_end 状态缺少 outcome（hand ${hand.handNumber}）`);
    }
    const boardLen = outcome.board.length;
    const streets: Street[] = [];
    if (boardLen >= 3) streets.push("flop");
    if (boardLen >= 4) streets.push("turn");
    if (boardLen >= 5) streets.push("river");
    const winnerHandRanks = outcome.showdown
      ? outcome.winners.map((seatIndex) => {
          const seat = hand.seats.find((s) => s.seatIndex === seatIndex);
          const cards = [...(seat?.holeCards ?? []), ...outcome.board];
          return cards.length >= 5 ? handRankName(evaluateHand(cards).rank) : "insufficient-cards";
        })
      : [];
    const previous = hands.length > 0 ? hands[hands.length - 1]! : null;
    return {
      handNumber: hand.handNumber,
      playersAtStart: hand.seats.length,
      smallBlind: hand.smallBlind,
      bigBlind: hand.bigBlind,
      previousBlinds: previous ? { sb: previous.smallBlind, bb: previous.bigBlind } : null,
      streets,
      showdown: outcome.showdown,
      potCount: outcome.pots.length,
      allInPlayers: hand.seats.filter((s) => s.isAllIn).length,
      shortAllInCount: currentShortAllIns,
      actionCounts: { ...currentActionCounts },
      winnerHandRanks,
      stackDepth: scenario2.stackDepth,
      agentStyle: scenario2.agentStyle,
    };
  }

  function toSimulationFailure(error: unknown): SimulationFailure {
    if (error instanceof SimulationFailure) return error;
    let category: SimulationFailureCategory = "engine-error";
    if (error instanceof WatchdogFailure) {
      category = `watchdog-${error.breach}`;
    } else if (error instanceof Error && (error.message.includes("不变量违反") || error.message.includes("事件序列"))) {
      category = "invariant-violation";
    }
    let state: TournamentState | null = null;
    let events: readonly PokerEvent[] = [];
    try {
      state = engine.getState();
      events = engine.getEvents();
    } catch {
      // 状态本身不可读时保留空现场（不得因采集现场而掩盖原始错误）。
    }
    return new SimulationFailure({
      category,
      message: error instanceof Error ? error.message : String(error),
      seed,
      scenario,
      actions,
      events,
      state,
      stats: options.statsSummary ? options.statsSummary() : null,
      forcedBlindMode: options.blindMode,
    });
  }

  let legal: LegalActions | null = null;
  try {
    legal = engine.startNextHand();
    watchdog.noteTransition();
    afterTransition();

    while (engine.getState().phase !== "finished") {
      if (legal === null) {
        if (!engine.getState().handInProgress) {
          if (scenario.blindMode === "time") {
            engine.recordElapsedTime(scenario.elapsedSecondsPerHand);
            watchdog.noteTransition();
            afterTransition();
          }
          legal = engine.startNextHand();
          watchdog.noteTransition();
          afterTransition();
          continue;
        }
        throw new Error(
          `引擎返回 null 但手仍在进行中（hand ${engine.getState().handNumber}）`,
        );
      }
      const hand = engine.getState().hand;
      const actor = hand?.currentActor ?? null;
      if (hand === null || actor === null) {
        throw new Error(`下注阶段缺少 currentActor（hand ${engine.getState().handNumber}）`);
      }
      const currentLegal = engine.getLegalActions();
      const action: PlayerAction = chooseAction(actor, currentLegal, agentRng, scenario.agentStyle);
      if (action.type === "all-in" && isShortAllIn(hand, currentLegal)) {
        currentShortAllIns++;
      }
      actions.push({
        hand: hand.handNumber,
        street: hand.street,
        seat: actor,
        type: action.type,
        amount: action.amount ?? null,
      });
      currentActionCounts[action.type] = (currentActionCounts[action.type] ?? 0) + 1;
      actionsTaken++;
      watchdog.noteAction();
      legal = engine.applyAction(action);
      watchdog.noteTransition();
      afterTransition();
    }
  } catch (error) {
    throw toSimulationFailure(error);
  }

  const finalState = engine.getState();
  return {
    seed,
    scenario,
    hands,
    actionsTaken,
    champion: finalState.champion,
    headsUpReached,
    elapsedMs: now() - startedAt,
  };
}
