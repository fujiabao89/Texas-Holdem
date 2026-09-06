import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type GameEvent, type GameEventMessage, type GameSnapshot } from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { gameSnapshot } from "../testing-fixtures";
import { AnimationQueue } from "./animation-queue";
import { animationTimings } from "./timings";

const check: GameEvent = { type: "PLAYER_CHECKED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } };
const award: GameEvent = { type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 15, awards: [{ playerId: "player-1", amount: 8 }, { playerId: "player-2", amount: 7 }], winningHandRank: null } };
const started: GameEvent = { type: "HAND_STARTED", payload: { handNumber: 2, dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0, blindLevel: 0 } };

function setup(options: ConstructorParameters<typeof AnimationQueue>[0] = {}) {
  const clock = createFakeClock();
  const queue = new AnimationQueue({ ...options, clock });
  let sequence = 1;
  queue.alignToSnapshot(gameSnapshot({ sequence: "1" }));
  const push = (event: GameEvent = check, handId = "hand-1", extra: Partial<GameSnapshot> = {}) => {
    const after = gameSnapshot({ ...extra, handId, sequence: String(++sequence) });
    const message = { type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: 1, payload: { tournamentId: after.tournamentId, sequence: after.sequence, handId, event, patch: {} } } as GameEventMessage;
    queue.enqueue(message, after);
    return { message, after };
  };
  return { queue, clock, push };
}

describe("presentation lifecycle", () => {
  it("keeps fresh sounds and public split-pot results in reduced motion without timed work", () => {
    const cues = vi.fn();
    const { queue, clock, push } = setup({ onEventStarted: cues });
    queue.setReducedMotion(true);
    push(award);
    expect(cues).toHaveBeenLastCalledWith(award, { immediate: true });
    expect(queue.getSnapshot()).toMatchObject({ reducedMotion: true, outcomeEvents: [award], overlay: null });
    expect(clock.pendingTimers()).toBe(0);
    push(started, "hand-2");
    expect(queue.getSnapshot().outcomeEvents).toEqual([]);
  });

  it("does not replay duplicate events, including when their cue has completed", () => {
    const cues = vi.fn();
    const { queue, clock, push } = setup({ onEventStarted: cues });
    const { message, after } = push();
    queue.enqueue(message, after);
    clock.advance(500);
    queue.enqueue(message, after);
    expect(cues).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().game?.sequence).toBe("2");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("flushes hidden-tab work silently and only animates new foreground events", () => {
    const cues = vi.fn();
    const { queue, clock, push } = setup({ onEventStarted: cues });
    push();
    queue.setForeground(false);
    push(award);
    for (let index = 0; index < 300; index += 1) push();
    expect(clock.pendingTimers()).toBe(0);
    expect(cues).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().game?.sequence).toBe("303");
    queue.setForeground(true);
    queue.alignToSnapshot(gameSnapshot({ sequence: "303" }));
    expect(queue.getSnapshot().outcomeEvents).toEqual([]);
    push();
    expect(cues).toHaveBeenCalledTimes(2);
    queue.cancel();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("retains visual pacing when the optional sound callback throws", () => {
    const { queue, clock, push } = setup({ onEventStarted: () => { throw new Error("audio unavailable"); } });
    push({ type: "TURN_DEALT", payload: { card: { rank: "Q", suit: "SPADES" } } });
    clock.advance(animationTimings.turnRiver - 1);
    expect(queue.getSnapshot().overlay?.kind).toBe("BOARD");
    clock.advance(1);
    expect(queue.getSnapshot().game?.sequence).toBe("2");
  });

  it("exposes unique event keys and the real shortened duration for catch-up feedback", () => {
    const { queue, clock, push } = setup();
    push();
    const firstKey = queue.getSnapshot().overlay?.eventKey;
    for (let index = 0; index < 10; index += 1) push();
    clock.advance(animationTimings.check);
    expect(queue.getSnapshot().overlay?.eventKey).not.toBe(firstKey);
    const duration = queue.getSnapshot().overlay!.durationMs;
    expect(duration).toBeLessThan(animationTimings.check);
    clock.advance(duration - 1);
    expect(queue.getSnapshot().game?.sequence).toBe("2");
    clock.advance(1);
    expect(queue.getSnapshot().game?.sequence).toBe("3");
  });

  it("preserves the active deal when the entire next hand is already queued", () => {
    const { queue, clock, push } = setup();
    const deal = (playerId: string, seat: number, cardIndex: 0 | 1): GameEvent => ({ type: "DEAL_HOLE_CARD", payload: { playerId, seat, cardIndex } });
    push(deal("player-1", 0, 0));
    push(deal("player-2", 1, 0));
    push(deal("player-1", 0, 1));
    push(deal("player-2", 1, 1));
    push(started, "hand-2");
    push(deal("player-1", 0, 0), "hand-2");
    push(deal("player-2", 1, 0), "hand-2");
    push(deal("player-1", 0, 1), "hand-2");
    push(deal("player-2", 1, 1), "hand-2");
    clock.advance(animationTimings.deal * 3);
    expect(queue.getSnapshot().holeDeal).toMatchObject({ handId: "hand-1", dealtCardCounts: { "player-1": 2, "player-2": 1 } });
    expect(queue.getSnapshot().overlay?.finalHoleCardDeal).toBe(true);
    clock.advance(animationTimings.deal + animationTimings.holeRevealPause + animationTimings.ownCardReveal + animationTimings.ownCardRevealStagger);
    expect(queue.getSnapshot().holeDeal).toMatchObject({ handId: "hand-2", dealtCardCounts: {} });
    queue.cancel();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("holds a public result before hard-forward, then cleans transition and notice timers", () => {
    const request = vi.fn();
    const { queue, clock, push } = setup({ onHardForward: request });
    push(award);
    for (let index = 0; index < 41; index += 1) push();
    expect(queue.getSnapshot()).toMatchObject({ mode: "HARD_FORWARD", notice: "SYNCED", outcomeEvents: [award] });
    expect(request).not.toHaveBeenCalled();
    clock.advance(999);
    expect(request).not.toHaveBeenCalled();
    clock.advance(1);
    expect(request).toHaveBeenCalledTimes(1);
    queue.alignToSnapshot(gameSnapshot({ sequence: "43" }));
    expect(queue.getSnapshot().notice).toBe("SYNCED");
    clock.advance(3000);
    expect(queue.getSnapshot().notice).toBeNull();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("cancels delayed audio on preference changes without replaying the discarded queue", () => {
    const reset = vi.fn();
    const cues = vi.fn();
    const { queue, clock, push } = setup({ onPresentationReset: reset, onEventStarted: cues });
    push();
    push(award);
    const resets = reset.mock.calls.length;
    queue.setReducedMotion(true);
    expect(reset).toHaveBeenCalledTimes(resets + 1);
    expect(cues).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().outcomeEvents).toEqual([award]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("holds the previous hand result when a new hand arrives during hard-forward and still requests a snapshot", () => {
    const request = vi.fn();
    const { queue, clock, push } = setup({ onHardForward: request });
    push(award);
    for (let index = 0; index < 41; index += 1) push();
    push(started, "hand-2");
    expect(queue.getSnapshot()).toMatchObject({ game: { handId: "hand-1" }, outcomeEvents: [award] });
    clock.advance(999);
    expect(queue.getSnapshot().outcomeEvents).toEqual([award]);
    clock.advance(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toMatchObject({ game: { handId: "hand-2" }, outcomeEvents: [] });
    queue.cancel();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("keeps the public reading window and snapshot request when reduced motion changes during hard-forward", () => {
    const request = vi.fn();
    const { queue, clock, push } = setup({ onHardForward: request });
    push(award);
    for (let index = 0; index < 41; index += 1) push();
    queue.setReducedMotion(true);
    push(started, "hand-2");
    expect(queue.getSnapshot()).toMatchObject({ reducedMotion: true, mode: "HARD_FORWARD", outcomeEvents: [award] });
    clock.advance(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toMatchObject({ game: { handId: "hand-2" }, outcomeEvents: [], mode: "NORMAL" });
    queue.cancel();
    expect(clock.pendingTimers()).toBe(0);
  });
});
