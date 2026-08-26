import { describe, expect, it } from "vitest";

import { createFakeClock } from "../../../../tests/support/fake-clock";
import { gameSnapshot } from "../testing-fixtures";
import { AnimationQueue } from "./animation-queue";

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

  it("clears old work at a reconnect snapshot barrier and hard forwards without replay", () => {
    const clock = createFakeClock();
    let hardForwards = 0;
    const queue = new AnimationQueue({ clock, onHardForward: () => { hardForwards += 1; } });
    queue.alignToSnapshot(gameSnapshot());
    for (let index = 0; index < 22; index += 1) queue.enqueue(event(String(9_007_199_254_740_992n + BigInt(index))), gameSnapshot({ sequence: String(9_007_199_254_740_992n + BigInt(index)) }));
    expect(hardForwards).toBe(1);
    queue.alignToSnapshot(gameSnapshot({ sequence: "9007199254741000" }));
    clock.advance(10_000);
    expect(queue.getSnapshot()).toMatchObject({ game: { sequence: "9007199254741000" }, overlay: null });
  });
});
