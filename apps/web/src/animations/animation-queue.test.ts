import { describe, expect, it } from "vitest";

import type { GameEventMessage } from "@texas-holdem/protocol";

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

  it("clears old work at a reconnect snapshot barrier and hard forwards without replay", () => {
    const clock = createFakeClock();
    let hardForwards = 0;
    const queue = new AnimationQueue({ clock, onHardForward: () => { hardForwards += 1; } });
    queue.alignToSnapshot(gameSnapshot());
    for (let index = 0; index < 42; index += 1) queue.enqueue(event(String(9_007_199_254_740_992n + BigInt(index))), gameSnapshot({ sequence: String(9_007_199_254_740_992n + BigInt(index)) }));
    expect(hardForwards).toBe(1);
    queue.alignToSnapshot(gameSnapshot({ sequence: "9007199254741000" }));
    clock.advance(10_000);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: "9007199254741000" }, overlay: null });
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

  it("budgets Hard Fast Forward above a readable two-player all-in showdown", () => {
    const normalTwoPlayerAllInBurst = animationTimings.allIn + animationTimings.wager
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
