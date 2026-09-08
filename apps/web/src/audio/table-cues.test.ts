import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "@texas-holdem/protocol";

import { gameSnapshot } from "../testing-fixtures";
import { TableCueTracker } from "./table-cues";

function setup() {
  const tracker = new TableCueTracker();
  let sequence = 9_007_199_254_740_991n;
  let game = gameSnapshot({ sequence: String(sequence), currentActorPlayerId: "player-2" });
  tracker.reset(game);
  const accept = (overrides: Partial<GameSnapshot> = {}) => {
    game = { ...game, sequence: String(++sequence), ...overrides };
    return tracker.accept(game);
  };
  return { tracker, accept, getGame: () => game };
}

describe("canonical table reminders", () => {
  it("announces a new own action once and cancels it when the opportunity ends", () => {
    const { accept } = setup();
    expect(accept({ currentActorPlayerId: "player-1" })).toEqual({ cue: "yourTurn", cancelPending: true });
    expect(accept({ actionDeadline: 40_000 })).toEqual({ cue: null, cancelPending: false });
    expect(accept({ actionDeadline: 70_000 })).toEqual({ cue: null, cancelPending: false });
    expect(accept({ currentActorPlayerId: "player-2" })).toEqual({ cue: null, cancelPending: true });
    expect(accept({ currentActorPlayerId: "player-1" })).toEqual({ cue: "yourTurn", cancelPending: true });
    expect(accept({ handPhase: "HAND_END" })).toEqual({ cue: null, cancelPending: true });
  });

  it("treats a new street or hand as a fresh turn, not a time-bank extension", () => {
    const { accept } = setup();
    accept({ currentActorPlayerId: "player-1" });
    expect(accept({ handPhase: "FLOP" })).toEqual({ cue: "yourTurn", cancelPending: true });
    expect(accept({ handId: "hand-2", handPhase: "PREFLOP" })).toEqual({ cue: "yourTurn", cancelPending: true });
  });

  it("announces blind increases once and gives an own-turn transition priority", () => {
    const { accept } = setup();
    const blindLevel = { index: 1, smallBlind: 10, bigBlind: 20, ante: 0 };
    expect(accept({ blindLevel })).toEqual({ cue: "blindLevel", cancelPending: true });
    expect(accept({ blindLevel })).toEqual({ cue: null, cancelPending: false });
    expect(accept({ blindLevel: { ...blindLevel, index: 2 }, currentActorPlayerId: "player-1" })).toEqual({ cue: "yourTurn", cancelPending: true });
    expect(accept({ blindLevel })).toEqual({ cue: null, cancelPending: true });
  });

  it("never treats snapshots, reconnect resets or a replacement tournament as live turn events", () => {
    const { tracker, accept, getGame } = setup();
    tracker.reset(gameSnapshot({ sequence: getGame().sequence }));
    expect(accept({ currentActorPlayerId: "player-1" })).toEqual({ cue: null, cancelPending: false });
    expect(accept({ tournamentId: "tournament-2" })).toEqual({ cue: null, cancelPending: true });
    tracker.reset(null);
    expect(accept()).toEqual({ cue: null, cancelPending: true });
  });

  it("ignores duplicate and stale sequences beyond Number precision without changing the baseline", () => {
    const { tracker, accept, getGame } = setup();
    const previous = getGame();
    accept({ currentActorPlayerId: "player-1" });
    expect(tracker.accept(getGame())).toEqual({ cue: null, cancelPending: false });
    expect(tracker.accept(previous)).toEqual({ cue: null, cancelPending: false });
    expect(accept()).toEqual({ cue: null, cancelPending: false });
  });

  it("does not announce turns for spectators, unavailable legal actions or terminal games", () => {
    const { accept, getGame } = setup();
    expect(accept({ currentActorPlayerId: "player-1", viewer: { ...getGame().viewer, role: "ELIMINATED_SPECTATOR" } }).cue).toBeNull();
    expect(accept({ viewer: { ...getGame().viewer, role: "PLAYER", legalActions: null } }).cue).toBeNull();
    expect(accept({ tournamentStatus: "FINISHED", blindLevel: { index: 1, smallBlind: 10, bigBlind: 20, ante: 0 } })).toEqual({ cue: null, cancelPending: true });
  });
});
