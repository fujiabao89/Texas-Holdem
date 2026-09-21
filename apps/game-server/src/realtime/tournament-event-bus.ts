import type { ClockUpdatedPayload, GameEventMessage } from "@texas-holdem/protocol";

/** Internal fan-out seam between TEX-20 runtime output and the single WS gateway. */
export interface TournamentEventBus {
  emitEvents(messages: readonly GameEventMessage[]): void;
  emitClockUpdated(payload: ClockUpdatedPayload): void;
  requestGameSnapshots(tournamentId: string): void;
  subscribe(listener: TournamentEventListener): () => void;
}

export interface TournamentEventListener {
  onEvents(messages: readonly GameEventMessage[]): void;
  onClockUpdated(payload: ClockUpdatedPayload): void;
  onGameSnapshotsRequested(tournamentId: string): void;
}

export function createTournamentEventBus(): TournamentEventBus {
  const listeners = new Set<TournamentEventListener>();
  return {
    emitEvents(messages) {
      for (const listener of listeners) listener.onEvents(messages);
    },
    emitClockUpdated(payload) {
      for (const listener of listeners) listener.onClockUpdated(payload);
    },
    requestGameSnapshots(tournamentId) {
      for (const listener of listeners) listener.onGameSnapshotsRequested(tournamentId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
