import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type Card, type GameEvent, type GameEventMessage } from "@texas-holdem/protocol";

import type { AppliedHandEvent } from "../../state/projection-store";
import { buildHandTimeline, handHistoryWinnerNames, playerNameLookup } from "./hand-timeline";
import type { HandHistoryItem } from "./hand-history-model";

function message(event: GameEvent, sequence: string, handId: string | null = "hand-1"): GameEventMessage {
  return { type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: 0, payload: { tournamentId: "tournament-1", sequence, handId, event, patch: {} } };
}

function applied(event: GameEvent, sequence: string, handId: string | null = "hand-1"): AppliedHandEvent {
  return { handId, sequence, event };
}

const holeCard = { rank: "A" as const, suit: "SPADES" as const };
const revealedCards: Card[] = [holeCard, { rank: "A", suit: "HEARTS" }];
const bestFiveCards: Card[] = [...revealedCards, { rank: "K", suit: "HEARTS" }, { rank: "9", suit: "SPADES" }, { rank: "7", suit: "CLUBS" }];
const handRank = { category: "ONE_PAIR" as const, tiebreakRanks: ["A", "K", "9", "7"] as Card["rank"][], bestFiveCards, label: "一对 A" };

/** A full projected hand: blinds, deal, streets, showdown and settlement. */
function fullHandEvents(): GameEventMessage[] {
  return [
    message({ type: "HAND_STARTED", payload: { handNumber: 3, dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 0, blindLevel: 0 } }, "1"),
    message({ type: "BLIND_POSTED", payload: { playerId: "player-2", seat: 1, blindType: "SMALL_BLIND", amount: 5, betTo: 5 } }, "2"),
    message({ type: "BLIND_POSTED", payload: { playerId: "player-1", seat: 0, blindType: "BIG_BLIND", amount: 10, betTo: 10 } }, "3"),
    message({ type: "DEAL_HOLE_CARD", payload: { playerId: "player-1", seat: 0, cardIndex: 0, card: holeCard } }, "4"),
    message({ type: "DEAL_HOLE_CARD", payload: { playerId: "player-2", seat: 1, cardIndex: 0 } }, "5"),
    message({ type: "BURN_CARD", payload: { street: "FLOP" } }, "6"),
    message({ type: "FLOP_DEALT", payload: { cards: [{ rank: "3", suit: "CLUBS" }, { rank: "K", suit: "HEARTS" }, { rank: "7", suit: "CLUBS" }] } }, "7"),
    message({ type: "PLAYER_CHECKED", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET" } }, "8"),
    message({ type: "PLAYER_BET", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 20, betTo: 20 } }, "9"),
    message({ type: "PLAYER_FOLDED", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET" } }, "10"),
    message({ type: "BURN_CARD", payload: { street: "TURN" } }, "11"),
    message({ type: "TURN_DEALT", payload: { card: { rank: "2", suit: "DIAMONDS" } } }, "12"),
    message({ type: "BURN_CARD", payload: { street: "RIVER" } }, "13"),
    message({ type: "RIVER_DEALT", payload: { card: { rank: "9", suit: "SPADES" } } }, "14"),
    message({ type: "SHOWDOWN_STARTED", payload: { contenderPlayerIds: ["player-1"] } }, "15"),
    message({ type: "PLAYER_REVEALED", payload: { playerId: "player-1", seat: 0, cards: revealedCards, handRank } }, "16"),
    message({ type: "UNCALLED_BET_RETURNED", payload: { playerId: "player-1", seat: 0, amount: 20 } }, "17"),
    message({ type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 15, awards: [{ playerId: "player-1", amount: 15 }], winningHandRank: handRank } }, "18"),
    message({ type: "PLAYER_ELIMINATED", payload: { playerId: "player-2", finishPosition: 2, tied: false } }, "19"),
    message({ type: "TOURNAMENT_FINISHED", payload: { winnerPlayerId: "player-1", rankings: [{ playerId: "player-1", finishPosition: 1, tied: false }, { playerId: "player-2", finishPosition: 2, tied: false }] } }, "20"),
  ];
}

describe("buildHandTimeline", () => {
  it("preserves an explicit no-champion outcome for display", () => {
    expect(buildHandTimeline([message({ type: "TOURNAMENT_FINISHED", payload: { winnerPlayerId: null, rankings: [] } }, "1")])).toEqual([
      { stage: "RESULT", entries: [{ kind: "TOURNAMENT_END", winnerPlayerId: null }] },
    ]);
  });
  it("keeps boundary withdrawals out of the next hand's Pre-Flop / Result stages", () => {
    const boundary: GameEvent = { type: "PLAYER_WITHDRAWN", payload: { playerId: "player-3", seat: 2, forfeitedChips: 500 } };
    expect(buildHandTimeline([message(boundary, "0", null), ...fullHandEvents()])).toEqual(buildHandTimeline(fullHandEvents()));
    expect(buildHandTimeline([applied(boundary, "0", null), ...fullHandEvents()])).toEqual(buildHandTimeline(fullHandEvents()));
  });
  it("groups a full hand into Pre-Flop / Flop / Turn / River / Showdown / Result stages", () => {
    const stages = buildHandTimeline(fullHandEvents());
    expect(stages.map((stage) => stage.stage)).toEqual(["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN", "RESULT"]);
    expect(stages[0].entries.map((entry) => entry.kind)).toEqual(["HAND_START", "BLIND", "BLIND", "DEAL_HOLE", "DEAL_HOLE"]);
    expect(stages[1].entries.map((entry) => entry.kind)).toEqual(["STREET_CARDS", "ACTION", "ACTION", "ACTION"]);
    expect(stages[4].entries.map((entry) => entry.kind)).toEqual(["REVEAL", "UNCALLED_RETURN"]);
    expect(stages[5].entries.map((entry) => entry.kind)).toEqual(["POT_AWARDED", "ELIMINATION", "TOURNAMENT_END"]);
  });

  it("accepts both wire messages and projection-buffered events as sources", () => {
    const fromMessages = buildHandTimeline(fullHandEvents());
    const fromApplied = buildHandTimeline(fullHandEvents().map((entry) => applied(entry.payload.event, entry.payload.sequence, entry.payload.handId)));
    expect(fromApplied).toEqual(fromMessages);
  });

  it("maps every public action type with its amount and target investment", () => {
    const stages = buildHandTimeline([
      message({ type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } }, "1"),
      message({ type: "PLAYER_CALLED", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET", amount: 10, betTo: 10 } }, "2"),
      message({ type: "PLAYER_BET", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 25, betTo: 25 } }, "3"),
      message({ type: "PLAYER_RAISED", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET", amount: 40, raiseTo: 65, isFullRaise: true } }, "4"),
      message({ type: "PLAYER_ALL_IN", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 990, betTo: 1_000 } }, "5"),
      message({ type: "PLAYER_FOLDED", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET" } }, "6"),
    ]);
    const actions = stages.flatMap((stage) => stage.entries).map((entry) => entry.kind === "ACTION" ? entry.action : null);
    expect(actions).toEqual([
      { type: "CHECK", amount: null, betTo: null },
      { type: "CALL", amount: 10, betTo: 10 },
      { type: "BET", amount: 25, betTo: 25 },
      { type: "RAISE", amount: 40, betTo: 65 },
      { type: "ALL_IN", amount: 990, betTo: 1_000 },
      { type: "FOLD", amount: null, betTo: null },
    ]);
  });

  it("never carries a hole-card value in a deal entry, even if a payload somehow includes one", () => {
    const stages = buildHandTimeline([
      message({ type: "DEAL_HOLE_CARD", payload: { playerId: "player-2", seat: 1, cardIndex: 0, card: holeCard } }, "1"),
    ]);
    expect(stages[0].entries).toEqual([{ kind: "DEAL_HOLE", playerId: "player-2", seat: 1 }]);
  });

  it("omits burn cards and stage-only markers from the user-facing timeline", () => {
    const stages = buildHandTimeline([
      message({ type: "BURN_CARD", payload: { street: "FLOP" } }, "1"),
      message({ type: "SHOWDOWN_STARTED", payload: { contenderPlayerIds: ["player-1"] } }, "2"),
    ]);
    // Filtered-only events produce no stage at all; empty stages never render.
    expect(stages).toEqual([]);
    // The showdown marker still advances the stage for later entries.
    const withReveal = buildHandTimeline([
      message({ type: "SHOWDOWN_STARTED", payload: { contenderPlayerIds: ["player-1"] } }, "1"),
      message({ type: "PLAYER_REVEALED", payload: { playerId: "player-1", seat: 0, cards: revealedCards, handRank } }, "2"),
    ]);
    expect(withReveal.map((stage) => stage.stage)).toEqual(["SHOWDOWN"]);
  });

  it("reports pot awards with the winning hand rank when the server provides one", () => {
    const stages = buildHandTimeline([
      message({ type: "POT_AWARDED", payload: { potIndex: 1, potAmount: 60, awards: [{ playerId: "player-1", amount: 30 }, { playerId: "player-2", amount: 30 }], winningHandRank: null } }, "1"),
    ]);
    expect(stages[0].entries).toEqual([{ kind: "POT_AWARDED", potIndex: 1, potAmount: 60, awards: [{ playerId: "player-1", amount: 30 }, { playerId: "player-2", amount: 30 }], winningHandRankLabel: null }]);
  });

  it("includes withdrawn players and their forfeited chips in the result stage", () => {
    const stages = buildHandTimeline([
      message({ type: "PLAYER_WITHDRAWN", payload: { playerId: "player-2", seat: 1, forfeitedChips: 500 } }, "1"),
    ]);
    expect(stages).toEqual([{ stage: "RESULT", entries: [{ kind: "WITHDRAWN", playerId: "player-2", seat: 1, forfeitedChips: 500 }] }]);
  });
});

describe("player name lookup", () => {
  it("falls back to the opaque id when no display name is known", () => {
    const lookup = playerNameLookup(new Map([["player-1", "玩家甲"]]));
    expect(lookup("player-1")).toBe("玩家甲");
    expect(lookup("player-2")).toBe("player-2");
  });

  it("maps hand-history winner ids through the same lookup", () => {
    const item: HandHistoryItem = {
      handId: "hand-1", handNumber: 1, startedAt: 1_000, endedAt: 2_000, smallBlind: 5, bigBlind: 10,
      communityCards: [], endReason: "SHOWDOWN", potTotal: 30, winnerPlayerIds: ["player-1", "player-9"],
    };
    expect(handHistoryWinnerNames(item, new Map([["player-1", "玩家甲"]]))).toEqual(["玩家甲", "player-9"]);
  });
});
