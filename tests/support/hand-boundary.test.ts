import { describe, expect, it } from "vitest";
import { completedHandIds } from "./timeline-evidence";

const frame = (sequence: string, event: string, handId = "h1") => ({
  type: "GAME_EVENT",
  sequence,
  event,
  handId,
  phase: "HAND_END",
});
describe("timeline driver waits for the whole terminal batch", () => {
  it("does not treat a showdown patch or first side-pot award as the end of the batch", () => {
    const pending = [
      frame("1", "SHOWDOWN_STARTED"),
      frame("2", "PLAYER_REVEALED"),
      frame("3", "POT_AWARDED"),
    ];
    expect(completedHandIds(pending).size).toBe(0);
    pending.push(frame("4", "POT_AWARDED"));
    expect(completedHandIds(pending).size).toBe(0);
    expect([
      ...completedHandIds([
        ...pending,
        { type: "GAME_SNAPSHOT", handId: "h1", sequence: "4", phase: "SHOWDOWN_DISPLAY" },
      ]),
    ]).toEqual(["h1"]);
  });
  it("recognizes fold-to-win at the next hand and final settlement at tournament finish", () => {
    expect([
      ...completedHandIds([frame("1", "POT_AWARDED"), frame("2", "HAND_STARTED", "h2")]),
    ]).toEqual(["h1"]);
    expect([
      ...completedHandIds([frame("1", "POT_AWARDED"), frame("2", "TOURNAMENT_FINISHED")]),
    ]).toEqual(["h1"]);
  });
  it("allows an authoritative terminal recovery to progress while branch assertions detect missing awards", () => {
    expect([
      ...completedHandIds([
        { type: "GAME_SNAPSHOT", handId: "h1", sequence: "42", phase: "SHOWDOWN_DISPLAY" },
      ]),
    ]).toEqual(["h1"]);
    expect(completedHandIds([frame("1", "HAND_STARTED")]).size).toBe(0);
  });
});
