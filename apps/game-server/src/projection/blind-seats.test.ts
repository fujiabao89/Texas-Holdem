import { describe, expect, it } from "vitest";
import { SeededRandomSource, TournamentEngine, type TournamentState } from "@texas-holdem/poker-engine";
import { applyPlayerViewPatch, PlayerViewSchema } from "@texas-holdem/protocol";
import { projectPlayerView, projectViewPatch, projectWireEvent, type ProjectionInput } from "./state-projector";

const config = {
  maxPlayers: 10, startingStack: 1000, smallBlind: 5, bigBlind: 10,
  blindMode: "fixed" as const, blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30 as const, timeBank: 60 as const,
};

function makeEngine(seats: number[], startingStack = 1000): TournamentEngine {
  return new TournamentEngine({ ...config, startingStack }, new SeededRandomSource(42), seats.map((seatIndex) => ({ seatIndex, name: `Player ${seatIndex}`, kind: "human" })), { firstDealerSeat: seats[0] });
}

function input(state: TournamentState, viewer = state.participants[0]!.seatIndex): ProjectionInput {
  return {
    tournamentId: "t1", handId: state.hand === null ? null : `h${state.hand.handNumber}`, sequence: state.nextSequence,
    engineState: state, seatToPlayer: new Map(state.participants.map((p) => [p.seatIndex, `p${p.seatIndex}`])),
    actionDeadline: null, currentLegalActions: null, timeBankRemainingMs: new Map(), viewerPlayerId: `p${viewer}`,
  };
}

function seats(view: { dealerSeat: number | null; smallBlindSeat: number | null; bigBlindSeat: number | null }) {
  return [view.dealerSeat, view.smallBlindSeat, view.bigBlindSeat];
}

function finishByFolding(engine: TournamentEngine): void {
  while (engine.getState().handInProgress) engine.applyAction({ type: "fold", seatIndex: engine.getState().hand!.currentActor!, source: "human_socket" });
}

describe("TEX-53 authoritative blind seats", () => {
  it.each([2, 3, 6, 10])("projects %i-player starts, per-event patches and dealer rotation", (count) => {
    const engine = makeEngine(Array.from({ length: count }, (_, i) => i));
    let previous = projectPlayerView(input(engine.getState()));
    expect(seats(previous)).toEqual([0, null, null]);
    for (let handNumber = 1; handNumber <= 3; handNumber++) {
      const offset = engine.getEvents().length;
      engine.startNextHand();
      const state = engine.getState();
      const dealer = handNumber - 1 < count ? handNumber - 1 : 0;
      const expected = [dealer, count === 2 ? dealer : (dealer + 1) % count, (dealer + (count === 2 ? 1 : 2)) % count];
      const current = projectPlayerView(input(state));
      expect(seats(current)).toEqual(expected);
      const events = engine.getEvents().slice(offset);
      const states = engine.getEventStates().slice(offset);
      events.forEach((event, index) => {
        const eventInput = input({ ...state, hand: states[index]! });
        const patch = projectViewPatch(eventInput);
        previous = applyPlayerViewPatch(previous, patch);
        expect(previous).toEqual(PlayerViewSchema.parse(projectPlayerView(eventInput)));
        expect(seats(previous)).toEqual(expected);
        if (event.type === "HAND_STARTED") {
          const wire = projectWireEvent(event, { seatToPlayer: eventInput.seatToPlayer, viewerPlayerId: eventInput.viewerPlayerId, blindLevelIndex: 0, board: [] });
          expect(wire.payload).toMatchObject({ dealerSeat: expected[0], smallBlindSeat: expected[1], bigBlindSeat: expected[2] });
        }
      });
      for (const participant of state.participants) {
        const view = projectPlayerView(input(state, participant.seatIndex));
        expect(seats(view)).toEqual(expected);
        expect(view.players.every((p) => p.revealedCards.length === 0)).toBe(true);
        expect(view.viewer.holeCards).toHaveLength(2);
      }
      finishByFolding(engine);
      expect(seats(projectPlayerView(input(engine.getState())))).toEqual(expected);
    }
  });

  it("skips empty and withdrawn seats across hands without changing this hand's blind posts", () => {
    const engine = makeEngine([0, 2, 4, 6]);
    engine.startNextHand();
    expect(seats(projectPlayerView(input(engine.getState())))).toEqual([0, 2, 4]);
    engine.withdrawParticipant(2);
    expect(seats(projectPlayerView(input(engine.getState())))).toEqual([0, 2, 4]);
    finishByFolding(engine);
    engine.startNextHand();
    expect(seats(projectPlayerView(input(engine.getState())))).toEqual([4, 6, 0]);
    const withdrawn = projectPlayerView(input(engine.getState(), 2));
    expect(seats(withdrawn)).toEqual([4, 6, 0]);
    expect(withdrawn.viewer).toMatchObject({ role: "ELIMINATED_SPECTATOR", holeCards: [], legalActions: null });
  });

  it("skips an eliminated seat after real all-in settlement and exposes the same seats to its spectator", () => {
    const engine = makeEngine([0, 2, 4, 6], 100);
    engine.startNextHand();
    // Two players contest an all-in; the others fold and survive for the next hand.
    engine.applyAction({ type: "fold", seatIndex: 6, source: "human_socket" });
    engine.applyAction({ type: "fold", seatIndex: 0, source: "human_socket" });
    while (engine.getState().handInProgress) engine.applyAction({ type: engine.getLegalActions().canAllIn ? "all-in" : "call", seatIndex: engine.getState().hand!.currentActor!, source: "human_socket" });
    const eliminated = engine.getState().participants.filter((p) => p.status === "ELIMINATED");
    expect(eliminated).toHaveLength(1);
    const excluded = eliminated[0]!.seatIndex;
    engine.startNextHand();
    const state = engine.getState();
    const view = projectPlayerView(input(state, excluded));
    expect(seats(view)).not.toContain(excluded);
    expect(seats(view)).toEqual(seats(projectPlayerView(input(state, 0))));
    expect(view.viewer).toMatchObject({ role: "ELIMINATED_SPECTATOR", holeCards: [], legalActions: null });
  });

  it("reads dealer from the current hand, and clears blind seats when restored between hands", () => {
    const engine = makeEngine([0, 2, 4]);
    engine.startNextHand();
    const state = engine.getState();
    expect(seats(projectPlayerView(input({ ...state, dealerSeat: 4 })))).toEqual([0, 2, 4]);
    finishByFolding(engine);
    const restored = TournamentEngine.restore(engine.getState(), new SeededRandomSource(7));
    expect(seats(projectPlayerView(input(restored.getState())))).toEqual([0, null, null]);
    restored.startNextHand();
    expect(seats(projectPlayerView(input(restored.getState())))).toEqual([2, 4, 0]);
  });

  it("keeps an earlier hand's event seats when the tournament has already advanced its dealer", () => {
    const engine = makeEngine([0, 2, 4]);
    engine.startNextHand();
    finishByFolding(engine);
    const previousHand = engine.getState().hand!;
    engine.startNextHand();
    const latest = engine.getState();
    const previousEvent = input({ ...latest, hand: previousHand });
    expect(seats(projectPlayerView(previousEvent))).toEqual([0, 2, 4]);
    expect(projectViewPatch(previousEvent)).toMatchObject({ dealerSeat: 0, smallBlindSeat: 2, bigBlindSeat: 4 });
    expect(seats(projectPlayerView(input(latest)))).toEqual([2, 4, 0]);
  });
});
