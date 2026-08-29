import { describe, expect, it } from "vitest";

import type { Card, GameEvent, GameEventMessage } from "@texas-holdem/protocol";

import { createFakeClock } from "../../../../tests/support/fake-clock";
import { gameSnapshot } from "../testing-fixtures";
import { AnimationQueue } from "./animation-queue";
import { animationTimings, hardForwardBacklogMs } from "./timings";

function event(sequence: string, type: "PLAYER_CHECKED" | "BURN_CARD" = "PLAYER_CHECKED") {
  return {
    type: "GAME_EVENT" as const, protocolVersion: 1 as const, serverTime: 1,
    payload: {
      tournamentId: "tournament-1", sequence, handId: "hand-1",
      event: type === "BURN_CARD" ? { type, payload: { street: "FLOP" as const } } : { type, payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" as const } },
      patch: {},
    },
  };
}

function gameEvent(sequence: string, next: GameEvent): GameEventMessage {
  return {
    type: "GAME_EVENT", protocolVersion: 1, serverTime: 1,
    payload: { tournamentId: "tournament-1", sequence, handId: "hand-1", event: next, patch: {} },
  } as GameEventMessage;
}

describe("AnimationQueue", () => {
  it("keeps canonical target ahead while presentation commits continuous events in order", () => {
    const clock = createFakeClock();
    const queue = new AnimationQueue({ clock });
    const first = gameSnapshot({ sequence: "9007199254740992", currentActorPlayerId: "player-2" });
    const second = gameSnapshot({ sequence: "9007199254740993", currentActorPlayerId: "player-1" });
    queue.alignToSnapshot(gameSnapshot());
    queue.enqueue(event(first.sequence), first);
    queue.enqueue(event(second.sequence), second);
    expect(queue.getSnapshot().game?.sequence).toBe("9007199254740991");
    clock.advance(140);
    expect(queue.getSnapshot().game?.sequence).toBe(first.sequence);
    clock.advance(140);
    expect(queue.getSnapshot().game?.sequence).toBe(second.sequence);
  });

  it("never creates a Burn face and commits final state for cancellation or reduced motion", () => {
    const clock = createFakeClock();
    const queue = new AnimationQueue({ clock });
    const after = gameSnapshot({ sequence: "9007199254740992" });
    queue.alignToSnapshot(gameSnapshot());
    queue.enqueue(event(after.sequence, "BURN_CARD"), after);
    expect(queue.getSnapshot().overlay).toMatchObject({ kind: "BURN", burnCardBackOnly: true, bestFiveCards: [] });
    queue.cancel();
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: after.sequence }, overlay: null });
    queue.enqueue(event("9007199254740993"), gameSnapshot({ sequence: "9007199254740993" }));
    queue.setReducedMotion(true);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: "9007199254740993" }, overlay: null, mode: "NORMAL" });
    const reducedAfterDeal = gameSnapshot({ sequence: "9007199254740994" });
    queue.enqueue(gameEvent(reducedAfterDeal.sequence, { type: "DEAL_HOLE_CARD", payload: { playerId: "player-1", seat: 0, cardIndex: 0, card: { rank: "A", suit: "SPADES" } } }), reducedAfterDeal);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: reducedAfterDeal.sequence }, overlay: null, holeDeal: null });
  });

  it("keeps public board destinations and server best-five data in the presentation task", () => {
    const clock = createFakeClock();
    const queue = new AnimationQueue({ clock });
    const before = gameSnapshot({ board: [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "SPADES" }, { rank: "Q", suit: "SPADES" }] });
    const turn = { rank: "J", suit: "SPADES" } as const;
    const afterTurn = gameSnapshot({ sequence: "9007199254740992", board: [...before.board, turn] });
    const turnEvent = {
      type: "GAME_EVENT", protocolVersion: 1, serverTime: 1,
      payload: { tournamentId: "tournament-1", sequence: afterTurn.sequence, handId: "hand-1", event: { type: "TURN_DEALT", payload: { card: turn } }, patch: {} },
    } as GameEventMessage;
    queue.alignToSnapshot(before);
    queue.enqueue(turnEvent, afterTurn);
    expect(queue.getSnapshot().overlay).toMatchObject({ kind: "BOARD", boardCards: [turn], boardStartIndex: 3 });

    queue.cancel();
    const reveal = {
      type: "GAME_EVENT", protocolVersion: 1, serverTime: 1,
      payload: {
        tournamentId: "tournament-1", sequence: "9007199254740993", handId: "hand-1",
        event: { type: "PLAYER_REVEALED", payload: {
          playerId: "player-2", seat: 1, cards: [{ rank: "10", suit: "SPADES" }, { rank: "2", suit: "HEARTS" }],
          handRank: { category: "STRAIGHT_FLUSH", tiebreakRanks: ["A"], label: "皇家同花顺", bestFiveCards: [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "SPADES" }, { rank: "Q", suit: "SPADES" }, { rank: "J", suit: "SPADES" }, { rank: "10", suit: "SPADES" }] },
        } }, patch: {},
      },
    } as GameEventMessage;
    queue.enqueue(reveal, gameSnapshot({ sequence: "9007199254740993" }));
    expect(queue.getSnapshot().overlay?.bestFiveCards).toHaveLength(5);
    expect(queue.getSnapshot().overlay?.bestFiveCards[4]).toEqual({ rank: "10", suit: "SPADES" });
  });

  it("deals two complete rounds before exposing the server-projected viewer pair for turnover", () => {
    const clock = createFakeClock();
    const queue = new AnimationQueue({ clock });
    const before = gameSnapshot({ viewer: { ...gameSnapshot().viewer, holeCards: [] }, players: gameSnapshot().players.map((player) => player.playerId === "player-1" ? { ...player, hasHoleCards: false } : player) });
    const viewerCards: Card[] = [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "SPADES" }];
    const after = (sequence: string) => gameSnapshot({ sequence, viewer: { ...gameSnapshot().viewer, holeCards: viewerCards }, players: gameSnapshot().players.map((player) => ({ ...player, hasHoleCards: true })) });
    queue.alignToSnapshot(before);
    queue.enqueue(gameEvent("9007199254740992", { type: "DEAL_HOLE_CARD", payload: { playerId: "player-1", seat: 0, cardIndex: 0, card: viewerCards[0] } }), after("9007199254740992"));
    queue.enqueue(gameEvent("9007199254740993", { type: "DEAL_HOLE_CARD", payload: { playerId: "player-2", seat: 1, cardIndex: 0 } }), after("9007199254740993"));
    queue.enqueue(gameEvent("9007199254740994", { type: "DEAL_HOLE_CARD", payload: { playerId: "player-1", seat: 0, cardIndex: 1, card: viewerCards[1] } }), after("9007199254740994"));
    queue.enqueue(gameEvent("9007199254740995", { type: "DEAL_HOLE_CARD", payload: { playerId: "player-2", seat: 1, cardIndex: 1 } }), after("9007199254740995"));

    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: before.sequence }, holeDeal: { dealtCardCounts: {}, viewerCardsForReveal: [] }, overlay: { kind: "DEAL", event: { payload: { playerId: "player-1", cardIndex: 0 } } } });
    clock.advance(animationTimings.deal * 3);
    expect(queue.getSnapshot()).toMatchObject({
      game: { sequence: "9007199254740994" },
      holeDeal: { dealtCardCounts: { "player-1": 2, "player-2": 1 }, viewerCardsForReveal: viewerCards },
      overlay: { event: { payload: { playerId: "player-2", cardIndex: 1 } } },
    });
    const finalDealDuration = animationTimings.deal + animationTimings.holeRevealPause + animationTimings.ownCardReveal + animationTimings.ownCardRevealStagger;
    clock.advance(finalDealDuration - 1);
    expect(queue.getSnapshot().game?.sequence).toBe("9007199254740994");
    expect(queue.getSnapshot().holeDeal?.viewerCardsForReveal).toEqual(viewerCards);
    clock.advance(1);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: "9007199254740995" }, overlay: null, holeDeal: null });
  });

  it("clears old work at a reconnect snapshot barrier and hard forwards without replay", () => {
    const clock = createFakeClock();
    let hardForwards = 0;
    const queue = new AnimationQueue({ clock, onHardForward: () => { hardForwards += 1; } });
    queue.alignToSnapshot(gameSnapshot());
    queue.enqueue(gameEvent("9007199254740992", { type: "DEAL_HOLE_CARD", payload: { playerId: "player-1", seat: 0, cardIndex: 0, card: { rank: "A", suit: "SPADES" } } }), gameSnapshot({ sequence: "9007199254740992" }));
    expect(queue.getSnapshot().holeDeal).not.toBeNull();
    queue.alignToSnapshot(gameSnapshot({ sequence: "9007199254740992" }));
    expect(queue.getSnapshot().holeDeal).toBeNull();
    for (let index = 0; index < 42; index += 1) queue.enqueue(event(String(9_007_199_254_740_992n + BigInt(index))), gameSnapshot({ sequence: String(9_007_199_254_740_992n + BigInt(index)) }));
    expect(hardForwards).toBe(1);
    queue.alignToSnapshot(gameSnapshot({ sequence: "9007199254741000" }));
    clock.advance(10_000);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: "9007199254741000" }, overlay: null, holeDeal: null });
  });

  it("uses soft catch-up instead of dropping a queued public showdown explanation", () => {
    const clock = createFakeClock();
    let hardForwards = 0;
    const queue = new AnimationQueue({ clock, onHardForward: () => { hardForwards += 1; } });
    queue.alignToSnapshot(gameSnapshot());
    const showdown = {
      type: "GAME_EVENT", protocolVersion: 1, serverTime: 1,
      payload: { tournamentId: "tournament-1", sequence: "9007199254740992", handId: "hand-1", event: { type: "SHOWDOWN_STARTED", payload: { contenderPlayerIds: ["player-1", "player-2"] } }, patch: {} },
    } as GameEventMessage;
    queue.enqueue(showdown, gameSnapshot({ sequence: "9007199254740992" }));
    for (let index = 0; index < 42; index += 1) {
      queue.enqueue(event(String(9_007_199_254_740_993n + BigInt(index))), gameSnapshot({ sequence: String(9_007_199_254_740_993n + BigInt(index)) }));
    }
    expect(hardForwards).toBe(0);
    expect(queue.getSnapshot()).toMatchObject({ overlay: { kind: "SHOWDOWN" } });
  });

  it("does not let Soft Catch-up complete a three-card board before its third visual frame", () => {
    const clock = createFakeClock();
    const queue = new AnimationQueue({ clock });
    const before = gameSnapshot();
    const allIn = gameSnapshot({ sequence: "9007199254740992" });
    const cards: Card[] = [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "HEARTS" }, { rank: "Q", suit: "CLUBS" }];
    const afterFlop = gameSnapshot({ sequence: "9007199254740993", board: cards });
    queue.alignToSnapshot(before);
    queue.enqueue(gameEvent(allIn.sequence, { type: "PLAYER_ALL_IN", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 10, betTo: 10 } }), allIn);
    queue.enqueue(gameEvent(afterFlop.sequence, { type: "FLOP_DEALT", payload: { cards } }), afterFlop);
    for (let index = 0; index < 9; index += 1) queue.enqueue(event(String(9_007_199_254_740_994n + BigInt(index))), gameSnapshot({ sequence: String(9_007_199_254_740_994n + BigInt(index)), board: cards }));

    clock.advance(animationTimings.allIn);
    expect(queue.getSnapshot()).toMatchObject({ mode: "SOFT_CATCH_UP", overlay: { kind: "BOARD", boardCards: cards } });
    const flopDuration = animationTimings.flopCard * 3 + animationTimings.flopInterval * 2;
    clock.advance(flopDuration - 1);
    expect(queue.getSnapshot().game?.sequence).toBe(allIn.sequence);
    clock.advance(1);
    expect(queue.getSnapshot().game?.sequence).toBe(afterFlop.sequence);
  });

  it("budgets Hard Fast Forward above a readable two-player all-in showdown", () => {
    const normalTwoPlayerAllInBurst = animationTimings.deal * 4
      + animationTimings.holeRevealPause + animationTimings.ownCardReveal + animationTimings.ownCardRevealStagger
      + animationTimings.wager * 2
      + animationTimings.allIn + animationTimings.wager
      + animationTimings.burn * 3
      + animationTimings.flopCard * 3 + animationTimings.flopInterval * 2
      + animationTimings.turnRiver * 2
      + animationTimings.check
      + (animationTimings.showdownReveal + animationTimings.bestFive) * 2
      + animationTimings.winner + animationTimings.potAward
      + animationTimings.fold + animationTimings.handEnd;
    expect(hardForwardBacklogMs).toBeGreaterThan(normalTwoPlayerAllInBurst);
  });
});
