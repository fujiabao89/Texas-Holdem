import type { Card, GameEvent, GameEventMessage } from "@texas-holdem/protocol";
import type { AppliedHandEvent } from "../../state/projection-store";
import type { HandHistoryItem } from "./hand-history-model";

/**
 * Pure presentation model for hand-history timelines (docs/05 §13): grouping
 * server-projected events into Pre-Flop / Flop / Turn / River / Showdown /
 * Result stages. It only reads the public projection contract and never
 * exposes sequence, burn cards or undisclosed hole cards.
 */

export type TimelineStage = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN" | "RESULT";

export type TimelineEntry =
  | { readonly kind: "HAND_START"; readonly handNumber: number; readonly dealerSeat: number; readonly smallBlindSeat: number; readonly bigBlindSeat: number }
  | { readonly kind: "BLIND"; readonly playerId: string; readonly seat: number; readonly blindType: "SMALL_BLIND" | "BIG_BLIND" | "ANTE"; readonly amount: number; readonly betTo: number }
  | { readonly kind: "DEAL_HOLE"; readonly playerId: string; readonly seat: number }
  | { readonly kind: "STREET_CARDS"; readonly cards: readonly Card[] }
  | { readonly kind: "ACTION"; readonly playerId: string; readonly seat: number; readonly action: ActionView }
  | { readonly kind: "REVEAL"; readonly playerId: string; readonly seat: number; readonly cards: readonly Card[]; readonly handRankLabel: string }
  | { readonly kind: "UNCALLED_RETURN"; readonly playerId: string; readonly seat: number; readonly amount: number }
  | { readonly kind: "POT_AWARDED"; readonly potIndex: number; readonly potAmount: number; readonly awards: readonly { readonly playerId: string; readonly amount: number }[]; readonly winningHandRankLabel: string | null }
  | { readonly kind: "ELIMINATION"; readonly playerId: string; readonly finishPosition: number; readonly tied: boolean }
  | { readonly kind: "TOURNAMENT_END"; readonly winnerPlayerId: string }
  | { readonly kind: "WITHDRAWN"; readonly playerId: string; readonly seat: number; readonly forfeitedChips: number };

export interface ActionView {
  readonly type: "CHECK" | "CALL" | "BET" | "ALL_IN" | "RAISE" | "FOLD";
  readonly amount: number | null;
  readonly betTo: number | null;
}

export interface StageView {
  readonly stage: TimelineStage;
  readonly entries: readonly TimelineEntry[];
}

export type TimelineEventSource = GameEventMessage | AppliedHandEvent;

function toEvent(source: TimelineEventSource): GameEvent {
  return "payload" in source ? source.payload.event : source.event;
}

function actionView(event: GameEvent): ActionView | null {
  switch (event.type) {
    case "PLAYER_CHECKED":
      return { type: "CHECK", amount: null, betTo: null };
    case "PLAYER_CALLED":
      return { type: "CALL", amount: event.payload.amount, betTo: event.payload.betTo };
    case "PLAYER_BET":
      return { type: "BET", amount: event.payload.amount, betTo: event.payload.betTo };
    case "PLAYER_ALL_IN":
      return { type: "ALL_IN", amount: event.payload.amount, betTo: event.payload.betTo };
    case "PLAYER_RAISED":
      return { type: "RAISE", amount: event.payload.amount, betTo: event.payload.raiseTo };
    case "PLAYER_FOLDED":
      return { type: "FOLD", amount: null, betTo: null };
    default:
      return null;
  }
}

function eventEntry(event: GameEvent): TimelineEntry | null {
  switch (event.type) {
    case "HAND_STARTED":
      return { kind: "HAND_START", handNumber: event.payload.handNumber, dealerSeat: event.payload.dealerSeat, smallBlindSeat: event.payload.smallBlindSeat, bigBlindSeat: event.payload.bigBlindSeat };
    case "BLIND_POSTED":
      return { kind: "BLIND", playerId: event.payload.playerId, seat: event.payload.seat, blindType: event.payload.blindType, amount: event.payload.amount, betTo: event.payload.betTo };
    case "DEAL_HOLE_CARD":
      // Other players' cards arrive without the card field (docs/02 §6.3 projection);
      // the timeline never renders a hole card value regardless of the payload shape.
      return { kind: "DEAL_HOLE", playerId: event.payload.playerId, seat: event.payload.seat };
    case "FLOP_DEALT":
      return { kind: "STREET_CARDS", cards: event.payload.cards };
    case "TURN_DEALT":
    case "RIVER_DEALT":
      return { kind: "STREET_CARDS", cards: [event.payload.card] };
    case "PLAYER_REVEALED":
      return { kind: "REVEAL", playerId: event.payload.playerId, seat: event.payload.seat, cards: event.payload.cards, handRankLabel: event.payload.handRank.label };
    case "UNCALLED_BET_RETURNED":
      return { kind: "UNCALLED_RETURN", playerId: event.payload.playerId, seat: event.payload.seat, amount: event.payload.amount };
    case "POT_AWARDED":
      return { kind: "POT_AWARDED", potIndex: event.payload.potIndex, potAmount: event.payload.potAmount, awards: event.payload.awards, winningHandRankLabel: event.payload.winningHandRank?.label ?? null };
    case "PLAYER_ELIMINATED":
      return { kind: "ELIMINATION", playerId: event.payload.playerId, finishPosition: event.payload.finishPosition, tied: event.payload.tied };
    case "PLAYER_WITHDRAWN":
      return { kind: "WITHDRAWN", playerId: event.payload.playerId, seat: event.payload.seat, forfeitedChips: event.payload.forfeitedChips };
    case "TOURNAMENT_FINISHED":
      return { kind: "TOURNAMENT_END", winnerPlayerId: event.payload.winnerPlayerId };
    case "BURN_CARD":
      // Burn cards are deliberately not part of the user-facing timeline.
      return null;
    case "SHOWDOWN_STARTED":
      // Stage marker only; showdown rows come from REVEAL / UNCALLED_RETURN events.
      return null;
    default: {
      const action = actionView(event);
      return action === null ? null : { kind: "ACTION", playerId: event.payload.playerId, seat: event.payload.seat, action };
    }
  }
}

function nextStage(event: GameEvent, current: TimelineStage): TimelineStage {
  switch (event.type) {
    case "FLOP_DEALT":
      return "FLOP";
    case "TURN_DEALT":
      return "TURN";
    case "RIVER_DEALT":
      return "RIVER";
    case "SHOWDOWN_STARTED":
    case "PLAYER_REVEALED":
    case "UNCALLED_BET_RETURNED":
      return "SHOWDOWN";
    case "POT_AWARDED":
    case "PLAYER_ELIMINATED":
    case "PLAYER_WITHDRAWN":
    case "TOURNAMENT_FINISHED":
      return "RESULT";
    default:
      return current;
  }
}

/** Groups projected events (ascending sequence order) into non-empty stage views. */
export function buildHandTimeline(events: readonly TimelineEventSource[]): readonly StageView[] {
  const stages: { stage: TimelineStage; entries: TimelineEntry[] }[] = [];
  let current: TimelineStage = "PREFLOP";
  for (const source of events) {
    const event = toEvent(source);
    current = nextStage(event, current);
    const entry = eventEntry(event);
    if (entry === null) continue;
    const last = stages[stages.length - 1];
    if (last !== undefined && last.stage === current) last.entries.push(entry);
    else stages.push({ stage: current, entries: [entry] });
  }
  return stages;
}

/** Player-name lookup shared by list and detail rendering; falls back to the opaque id. */
export function playerNameLookup(names: ReadonlyMap<string, string>): (playerId: string) => string {
  return (playerId) => names.get(playerId) ?? playerId;
}

export function handHistoryWinnerNames(item: HandHistoryItem, names: ReadonlyMap<string, string>): readonly string[] {
  const lookup = playerNameLookup(names);
  return item.winnerPlayerIds.map(lookup);
}
