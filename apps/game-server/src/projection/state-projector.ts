/**
 * 状态投影器（docs/02-protocol-spec.md §9；docs/04-game-server-architecture.md §11）。
 *
 * 只读纯函数：从 Engine 内部权威状态 + 运行时 overlay 投影出 schema 合法的
 * `PlayerView`，并把 Engine `PokerEvent` 映射为 wire `GameEvent`。投影器不做任何
 * 状态变更（§4 原则）；任何非授权信息（其他玩家底牌、Deck、Burn 牌面）在服务端源头
 * 删除（红线 2）。
 *
 * 关键映射（TEX-20）：
 * - Engine 事件 sequence 为 0 基内部流；wire `sequence` 由执行器分配（1 基跨手全局递增，
 *   02 §7.1）。本模块只消费执行器传入的当前值，不分配 sequence。
 * - Engine 座位号 → 协议 `playerId`：经执行器注入的 seatToPlayer 映射。
 * - Engine Card（数值 rank、小写 suit）→ wire Card（字符串 rank、UPPER_SNAKE suit）。
 * - `isFullRaise`：Engine 只允许完整加注进入 `PLAYER_RAISED`（短全下走 `ALL_IN`），恒为 true。
 * - `POT_AWARDED.winningHandRank` 与 `HAND_STARTED.blindLevel` 由执行器在 WireContext 提供。
 */

import { evaluateHand, handRankName } from "@texas-holdem/poker-engine";
import type { Card as WireCard, GameEvent, LegalActions, PlayerView, PlayerViewPatch } from "@texas-holdem/protocol";
import type { Card, PokerEvent, TournamentState } from "@texas-holdem/poker-engine";

/** 由协议 Schema 推导的类型（协议包不单独导出这些视图子类型）。 */
type HandRankView = Extract<GameEvent, { type: "PLAYER_REVEALED" }>["payload"]["handRank"];
type PokerStatus = PlayerView["players"][number]["pokerStatus"];
type RankingView = PlayerView["rankings"][number];

/** 一次视图投影所需的全部输入（执行器在每次状态转移后组装）。 */
export interface ProjectionInput {
  readonly tournamentId: string;
  /** 当前（或最近）手号对应的 handId；无手为 null。 */
  readonly handId: string | null;
  /** 当前 wire sequence（最后已分配事件的序号；尚无事件为 0）。 */
  readonly sequence: number;
  readonly engineState: TournamentState;
  /** seatIndex → playerId（本场参赛者映射，开局冻结）。 */
  readonly seatToPlayer: ReadonlyMap<number, string>;
  /** 当前行动截止线（Epoch ms）；无限时/无行动机会为 null。 */
  readonly actionDeadline: number | null;
  /** 当前行动者合法动作集合（Engine 输出）；当前 actor 且有限时才有。 */
  readonly currentLegalActions: LegalActions | null;
  /** playerId → timeBankRemainingMs（服务器权威，§8.4）。 */
  readonly timeBankRemainingMs: ReadonlyMap<string, number>;
  /** 接收者 playerId（逐接收者投影）。 */
  readonly viewerPlayerId: string;
}

/** Wire 事件映射所需的上下文（部分字段来自事件以外的当前状态）。 */
export interface WireProjectionContext {
  readonly seatToPlayer: ReadonlyMap<number, string>;
  readonly viewerPlayerId: string;
  /** 当前盲注等级索引（HAND_STARTED wire 需要；Engine 事件本身不携带）。 */
  readonly blindLevelIndex: number;
  /** 当前公共牌（PLAYER_REVEALED 计算牌型用）。 */
  readonly board: readonly Card[];
}

/** 投影当前状态为 schema 合法的 PlayerView（02 §9.2）。 */
export function projectPlayerView(input: ProjectionInput): PlayerView {
  const { engineState: state } = input;
  const hand = state.hand;
  const handSeatBySeat = new Map(hand?.seats.map((s) => [s.seatIndex, s]) ?? []);
  const revealed = revealedSeats(hand);
  const potViews = projectPots(hand, input.seatToPlayer);
  const currentActorSeat = hand?.currentActor ?? null;

  const players = state.participants.map((participant) => {
    const seatIndex = participant.seatIndex;
    const handSeat = handSeatBySeat.get(seatIndex);
    const handLive = hand !== null && hand.phase !== "hand_end";
    return {
      playerId: input.seatToPlayer.get(seatIndex) ?? "",
      displayName: participant.name,
      seat: seatIndex,
      stack: handSeat !== undefined ? handSeat.chips : participant.chips,
      streetBet: handSeat?.streetBet ?? 0,
      totalCommitted: handSeat?.handContribution ?? 0,
      pokerStatus: participant.status as PokerStatus,
      hasHoleCards: handLive && !handSeat?.folded && (handSeat?.holeCards.length ?? 0) > 0,
      revealedCards: revealed.has(seatIndex) ? handSeat?.holeCards.map(wireCard) ?? [] : [],
    };
  });

  const viewerSeat = seatOf(input.viewerPlayerId, input.seatToPlayer);
  const viewerHandSeat = viewerSeat !== null ? handSeatBySeat.get(viewerSeat) : undefined;
  const viewerRole = viewerRoleOf(state, input.viewerPlayerId, input.seatToPlayer);
  const viewerHoleCards =
    viewerRole === "PLAYER" &&
    hand !== null &&
    hand.phase !== "hand_end" &&
    !viewerHandSeat?.folded
      ? (viewerHandSeat?.holeCards.map(wireCard) ?? [])
      : [];

  return {
    handId: input.handId,
    tournamentStatus: state.phase === "finished" ? "FINISHED" : "RUNNING",
    handPhase: hand?.phase !== undefined ? wireHandPhase(hand.phase) : null,
    blindLevel: {
      index: state.blindLevel,
      smallBlind: state.smallBlind,
      bigBlind: state.bigBlind,
      ante: 0,
    },
    dealerSeat: state.dealerSeat,
    board: (hand?.communityCards ?? []).map(wireCard),
    pots: potViews,
    currentActorPlayerId:
      currentActorSeat !== null ? (input.seatToPlayer.get(currentActorSeat) ?? null) : null,
    actionDeadline: input.actionDeadline,
    players,
    viewer: {
      playerId: input.viewerPlayerId,
      role: viewerRole,
      holeCards: viewerHoleCards,
      legalActions:
        viewerRole === "PLAYER" && viewerSeat !== null && viewerSeat === currentActorSeat
          ? input.currentLegalActions
          : null,
      timeBankRemainingMs: input.timeBankRemainingMs.get(input.viewerPlayerId) ?? 0,
    },
    rankings: projectRankings(state, input.seatToPlayer),
  };
}

/** 全字段 `PlayerViewPatch`：每事件发送完整新视图，恒满足 apply(prev, patch) == after。 */
export function projectViewPatch(input: ProjectionInput): PlayerViewPatch {
  const view = projectPlayerView(input);
  return {
    handId: view.handId,
    tournamentStatus: view.tournamentStatus,
    handPhase: view.handPhase,
    blindLevel: view.blindLevel,
    dealerSeat: view.dealerSeat,
    board: view.board,
    pots: view.pots,
    currentActorPlayerId: view.currentActorPlayerId,
    actionDeadline: view.actionDeadline,
    players: view.players,
    viewer: view.viewer,
    rankings: view.rankings,
  };
}

/** 把 Engine 内部事件映射为 wire `GameEvent`（02 §8.3）；`card` 等私有字段按接收者过滤。 */
export function projectWireEvent(event: PokerEvent, ctx: WireProjectionContext): GameEvent {
  const seat = "seatIndex" in event ? event.seatIndex : undefined;
  const playerId = seat !== undefined ? ctx.seatToPlayer.get(seat) ?? "" : "";
  const seatOfPlayer = (seatIndex: number): string => ctx.seatToPlayer.get(seatIndex) ?? "";
  switch (event.type) {
    case "HAND_STARTED":
      return {
        type: "HAND_STARTED",
        payload: {
          handNumber: event.handNumber,
          dealerSeat: event.dealerSeat,
          smallBlindSeat: event.sbSeat,
          bigBlindSeat: event.bbSeat,
          blindLevel: ctx.blindLevelIndex,
        },
      };
    case "BLIND_POSTED":
      return {
        type: "BLIND_POSTED",
        payload: {
          playerId,
          seat: event.seatIndex,
          blindType: event.blind === "small" ? "SMALL_BLIND" : "BIG_BLIND",
          amount: event.amount,
          betTo: event.toAmount,
        },
      };
    case "DEAL_HOLE_CARD":
      return {
        type: "DEAL_HOLE_CARD",
        payload: {
          playerId,
          seat: event.seatIndex,
          cardIndex: (event.holeNumber - 1) as 0 | 1,
          card: playerId === ctx.viewerPlayerId ? wireCard(event.card) : undefined,
        },
      };
    case "BURN_CARD":
      return { type: "BURN_CARD", payload: { street: streetOf(event.street) } };
    case "FLOP_DEALT":
      return { type: "FLOP_DEALT", payload: { cards: event.cards.map(wireCard) } };
    case "TURN_DEALT":
      return { type: "TURN_DEALT", payload: { card: wireCard(event.card) } };
    case "RIVER_DEALT":
      return { type: "RIVER_DEALT", payload: { card: wireCard(event.card) } };
    case "PLAYER_CHECKED":
      return { type: "PLAYER_CHECKED", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source) } };
    case "PLAYER_FOLDED":
      return { type: "PLAYER_FOLDED", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source) } };
    case "PLAYER_CALLED":
      return { type: "PLAYER_CALLED", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source), amount: event.amount, betTo: event.toAmount } };
    case "PLAYER_BET":
      return { type: "PLAYER_BET", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source), amount: event.amount, betTo: event.toAmount } };
    case "PLAYER_ALL_IN":
      return { type: "PLAYER_ALL_IN", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source), amount: event.amount, betTo: event.toAmount } };
    case "PLAYER_RAISED":
      // 引擎只允许完整加注进入 RAISED（validateAction: raise >= minRaiseTo），isFullRaise 恒真。
      return { type: "PLAYER_RAISED", payload: { playerId, seat: event.seatIndex, source: wireSource(event.source), amount: event.amount, raiseTo: event.toAmount, isFullRaise: true } };
    case "SHOWDOWN_STARTED":
      return { type: "SHOWDOWN_STARTED", payload: { contenderPlayerIds: event.remainingPlayers.map(seatOfPlayer) } };
    case "PLAYER_REVEALED":
      return {
        type: "PLAYER_REVEALED",
        payload: {
          playerId,
          seat: event.seatIndex,
          cards: event.cards.map(wireCard),
          handRank: handRankViewOf([...event.cards, ...ctx.board]),
        },
      };
    case "UNCALLED_BET_RETURNED":
      return { type: "UNCALLED_BET_RETURNED", payload: { playerId, seat: event.seatIndex, amount: event.amount } };
    case "POT_AWARDED":
      return {
        type: "POT_AWARDED",
        payload: {
          potIndex: event.potIndex,
          potAmount: event.amount,
          awards: event.winners.map((winner) => ({
            playerId: seatOfPlayer(winner),
            amount: event.prizeBySeat[winner] ?? 0,
          })),
          winningHandRank: null,
        },
      };
    case "PLAYER_ELIMINATED":
      return {
        type: "PLAYER_ELIMINATED",
        payload: {
          playerId,
          finishPosition: event.placementRange.from,
          tied: event.placementRange.to > event.placementRange.from,
        },
      };
    case "PLAYER_WITHDRAWN":
      return {
        type: "PLAYER_WITHDRAWN",
        payload: { playerId, seat: event.seatIndex, forfeitedChips: event.forfeitedChips },
      };
    case "TOURNAMENT_FINISHED": {
      const winnerSeat = event.championSeat;
      return {
        type: "TOURNAMENT_FINISHED",
        payload: {
          winnerPlayerId: winnerSeat !== null ? seatOfPlayer(winnerSeat) : "",
          rankings: event.finalStandings.map((fs) => ({
            playerId: seatOfPlayer(fs.seatIndex),
            finishPosition: fs.placementRange.from,
            tied: fs.placementRange.to > fs.placementRange.from,
          })),
        },
      };
    }
  }
}

/** 结算/比牌中已公开底牌的座位（Showdown 全部非弃牌参与者，含 all-in；与 PLAYER_REVEALED 事件口径一致）。 */
function revealedSeats(hand: TournamentState["hand"]): ReadonlySet<number> {
  if (hand === null || hand.phase !== "hand_end" || hand.outcome === null || !hand.outcome.showdown) {
    return new Set();
  }
  const revealed = new Set<number>();
  for (const seat of hand.seats) {
    if (!seat.folded) revealed.add(seat.seatIndex);
  }
  return revealed;
}

/** 投影底池：结算后按 Pot 分层；下注进行中投影单一进行中底池（公开金额，非结算裁决）。 */
function projectPots(
  hand: TournamentState["hand"],
  seatToPlayer: ReadonlyMap<number, string>,
): Array<{ amount: number; eligiblePlayerIds: string[] }> {
  if (hand === null) return [];
  const ids = (seats: readonly number[]): string[] =>
    seats.map((s) => seatToPlayer.get(s) ?? "").filter((id) => id !== "");
  if (hand.phase === "hand_end" && hand.pots.length > 0) {
    return hand.pots.map((pot) => ({ amount: pot.amount, eligiblePlayerIds: ids(pot.eligiblePlayers) }));
  }
  const amount = hand.seats.reduce((sum, s) => sum + s.handContribution, 0);
  const eligible = hand.seats.filter((s) => !s.folded).map((s) => s.seatIndex);
  return [{ amount, eligiblePlayerIds: ids(eligible) }];
}

function projectRankings(
  state: TournamentState,
  seatToPlayer: ReadonlyMap<number, string>,
): RankingView[] {
  const source =
    state.finalStandings.length > 0
      ? state.finalStandings.map((fs) => ({ seatIndex: fs.seatIndex, placementRange: fs.placementRange, displayOrder: fs.displayOrder }))
      : state.eliminations.flatMap((group) =>
          group.players.map((seatIndex, i) => ({
            seatIndex,
            placementRange: group.placementRange,
            displayOrder: i + 1,
          })),
        );
  return source.map((standing) => ({
    playerId: seatToPlayer.get(standing.seatIndex) ?? "",
    placement: { from: standing.placementRange.from, to: standing.placementRange.to },
    displayOrder: standing.displayOrder,
  }));
}

/** 接收者角色：本场参赛者且未终结（ACTIVE/EXIT_PENDING）→ PLAYER；其余 → ELIMINATED_SPECTATOR。 */
function viewerRoleOf(
  state: TournamentState,
  viewerPlayerId: string,
  seatToPlayer: ReadonlyMap<number, string>,
): "PLAYER" | "ELIMINATED_SPECTATOR" {
  const seat = seatOf(viewerPlayerId, seatToPlayer);
  if (seat === null) return "ELIMINATED_SPECTATOR";
  const participant = state.participants.find((p) => p.seatIndex === seat);
  if (participant === undefined) return "ELIMINATED_SPECTATOR";
  return participant.status === "ACTIVE" || participant.status === "EXIT_PENDING"
    ? "PLAYER"
    : "ELIMINATED_SPECTATOR";
}

function seatOf(playerId: string, seatToPlayer: ReadonlyMap<number, string>): number | null {
  for (const [seat, id] of seatToPlayer) {
    if (id === playerId) return seat;
  }
  return null;
}

/** Engine Card（数值 rank / 小写 suit）→ wire Card（字符串 rank / UPPER_SNAKE suit）。 */
export function wireCard(card: Card): WireCard {
  return { rank: wireRank(card.rank), suit: card.suit.toUpperCase() as WireCard["suit"] };
}

const WIRE_RANK_BY_VALUE: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

function wireRank(rank: number): WireCard["rank"] {
  return (WIRE_RANK_BY_VALUE[rank] ?? String(rank)) as WireCard["rank"];
}

/** Engine HandPhase（小写）→ wire HandPhase（UPPER_SNAKE）。 */
function wireHandPhase(phase: string): NonNullable<PlayerView["handPhase"]> {
  switch (phase) {
    case "preflop":
      return "PREFLOP";
    case "flop":
      return "FLOP";
    case "turn":
      return "TURN";
    case "river":
      return "RIVER";
    default:
      return "HAND_END";
  }
}

/** Engine street（小写）→ wire street（UPPER_SNAKE；PREFLOP 不产生 burn）。 */
function streetOf(street: "preflop" | "flop" | "turn" | "river"): "FLOP" | "TURN" | "RIVER" {
  switch (street) {
    case "flop":
      return "FLOP";
    case "turn":
      return "TURN";
    case "river":
      return "RIVER";
    default:
      return "FLOP";
  }
}

/** Engine ActionSource（小写）→ wire（UPPER_SNAKE）。 */
function wireSource(source: string): "HUMAN_SOCKET" | "BOT_CONTROLLER" | "SYSTEM_TIMER" {
  switch (source) {
    case "human_socket":
      return "HUMAN_SOCKET";
    case "bot_controller":
      return "BOT_CONTROLLER";
    case "system_timer":
      return "SYSTEM_TIMER";
    default:
      return "SYSTEM_TIMER";
  }
}

const CATEGORY_BY_RANK: Record<number, HandRankView["category"]> = {
  0: "HIGH_CARD", 1: "ONE_PAIR", 2: "TWO_PAIR", 3: "THREE_OF_A_KIND", 4: "STRAIGHT",
  5: "FLUSH", 6: "FULL_HOUSE", 7: "FOUR_OF_A_KIND", 8: "STRAIGHT_FLUSH",
};

/** 由 5–7 张 Engine 牌计算 wire HandRankView；牌数不足时退化为 High Card（对局正常揭示时 board 已补满 5 张）。 */
function handRankViewOf(cards: readonly Card[]): HandRankView {
  if (cards.length >= 5) {
    const evaluation = evaluateHand(cards);
    return {
      category: CATEGORY_BY_RANK[evaluation.rank] ?? "HIGH_CARD",
      tiebreakRanks: evaluation.comparisonKey.slice(1).map(wireRank),
      label: handRankName(evaluation.rank),
    };
  }
  const highest = [...cards].sort((a, b) => b.rank - a.rank)[0];
  return {
    category: "HIGH_CARD",
    tiebreakRanks: highest !== undefined ? [wireRank(highest.rank)] : ["A"],
    label: "High Card",
  };
}
