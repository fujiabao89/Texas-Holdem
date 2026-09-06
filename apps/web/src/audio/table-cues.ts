import type { GameSnapshot } from "@texas-holdem/protocol";

import type { TableCue } from "./audio-controller";

/** Compares already-accepted projections; it does not generate protocol events. */
export class TableCueTracker {
  private previous: GameSnapshot | null = null;

  reset(game: GameSnapshot | null): void { this.previous = game; }

  accept(game: GameSnapshot): { readonly cue: TableCue | null; readonly cancelPending: boolean } {
    const previous = this.previous;
    // Accepted-event subscriptions already enforce this; keep the tracker
    // monotonic when used independently so an old notice cannot re-arm a turn.
    if (previous?.tournamentId === game.tournamentId && BigInt(game.sequence) <= BigInt(previous.sequence)) {
      return { cue: null, cancelPending: false };
    }
    this.previous = game;
    if (previous === null || previous.tournamentId !== game.tournamentId) {
      return { cue: null, cancelPending: true };
    }
    const previousTurn = ownTurnKey(previous);
    const nextTurn = ownTurnKey(game);
    const changedTurn = previousTurn !== nextTurn;
    const blindLevelChanged = previous.blindLevel.index !== game.blindLevel.index;
    const cue = changedTurn && nextTurn !== null
      ? "yourTurn"
      : game.tournamentStatus === "RUNNING" && game.blindLevel.index > previous.blindLevel.index
        ? "blindLevel"
        : null;
    return { cue, cancelPending: changedTurn || blindLevelChanged || game.tournamentStatus !== "RUNNING" };
  }
}

function ownTurnKey(game: GameSnapshot): string | null {
  if (game.tournamentStatus !== "RUNNING" || game.handId === null || game.handPhase === "HAND_END" ||
    game.viewer.role !== "PLAYER" || game.currentActorPlayerId !== game.viewer.playerId || game.viewer.legalActions === null) return null;
  // A deadline extension or another player's reveal does not create a turn.
  return `${game.tournamentId}:${game.handId}:${game.handPhase}:${game.viewer.playerId}`;
}
