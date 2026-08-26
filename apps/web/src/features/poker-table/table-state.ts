import type { GameSnapshot } from "@texas-holdem/protocol";

import type { ConnectionState } from "../../protocol/websocket-transport";

export function canSubmitTableAction(
  game: GameSnapshot | null,
  connectionState: ConnectionState,
  actionsDisabled: boolean,
  hasPendingCommand: boolean,
): boolean {
  return game !== null
    && game.viewer.playerId === game.currentActorPlayerId
    && game.viewer.legalActions !== null
    && !actionsDisabled
    && !hasPendingCommand
    && connectionState === "CONNECTED";
}

export function tableSeats(snapshot: GameSnapshot): readonly (typeof snapshot.players[number] | null)[] {
  return Array.from({ length: 10 }, (_, seat) => snapshot.players.find((player) => player.seat === seat) ?? null);
}

/** Presentation-only estimate; the server remains the authority on timeouts. */
export function remainingTimeMs(
  actionDeadline: number | null,
  serverTimeAtReceipt: number,
  performanceNowAtReceipt: number,
  currentPerformanceNow: number,
): number | null {
  if (actionDeadline === null) return null;
  const elapsedSinceReceipt = Math.max(0, currentPerformanceNow - performanceNowAtReceipt);
  return Math.max(0, actionDeadline - (serverTimeAtReceipt + elapsedSinceReceipt));
}
