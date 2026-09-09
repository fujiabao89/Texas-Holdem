import { describe, expect, it } from "vitest";
import type { GameEvent } from "@texas-holdem/protocol";
import { actionFeedback, awardedTo, feedbackFlight, publicHandRankName, relativeCenter } from "./event-feedback";

describe("server-projected table feedback", () => {
  it("anchors a travelling chip to measured centres inside the table border", () => {
    const source = relativeCenter({ x: 100, y: 80, width: 1000, height: 600 }, { x: 230, y: 480, width: 140, height: 60 }, { x: 18, y: 18 });
    const target = { x: 482, y: 212 };
    const flight = feedbackFlight(source, target);
    expect(source).toEqual({ x: 182, y: 412 });
    expect(flight.origin.x + flight.delta.x).toBe(target.x);
    expect(flight.origin.y + flight.delta.y).toBe(target.y);
    expect(feedbackFlight(target, source).delta).toEqual({ x: -flight.delta.x, y: -flight.delta.y });
  });

  it("uses per-player split awards and raiseTo, not guessed equal shares or amount", () => {
    const event: GameEvent = { type: "POT_AWARDED", payload: { potIndex: 1, potAmount: 101, awards: [{ playerId: "a", amount: 51 }, { playerId: "b", amount: 50 }], winningHandRank: null } };
    expect(awardedTo(event, "a")).toBe(51);
    expect(awardedTo(event, "b")).toBe(50);
    expect(awardedTo(event, "c")).toBeNull();
    expect(actionFeedback({ type: "PLAYER_RAISED", payload: { playerId: "a", seat: 2, source: "HUMAN_SOCKET", amount: 60, raiseTo: 100, isFullRaise: false } })).toContain("100");
  });

  it("never assigns a face/name to a Burn and translates only the public hand category", () => {
    expect(actionFeedback({ type: "BURN_CARD", payload: { street: "TURN" } })).toBeNull();
    expect(publicHandRankName({ category: "FLUSH", label: "arbitrary server wording", bestFiveCards: [], tiebreakRanks: [] })).toBe("同花");
  });
});
