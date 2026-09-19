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

/** The viewer always sits at the bottom centre; every other seat keeps its clockwise offset. */
const VIEWER_SEAT_SLOT = 5;

/**
 * Presentation-only seat mapping keyed by the server seatIndex. The viewer is
 * pinned to the bottom centre and each other seat keeps a fixed slot derived
 * from its clockwise offset, so updating actors, stacks, statuses or the set of
 * remaining players never reorders the seats still at the table (TEX-47).
 */
export function tableSeatSlots(snapshot: GameSnapshot): ReadonlyArray<number | null> {
  const slots = Array<number | null>(10).fill(null);
  const viewer = snapshot.players.find((player) => player.playerId === snapshot.viewer.playerId);
  if (viewer === undefined) return slots;
  for (const player of snapshot.players) {
    const offset = (player.seat - viewer.seat + 10) % 10;
    slots[player.seat] = (VIEWER_SEAT_SLOT + offset) % 10;
  }
  return slots;
}

export type SeatBadge = "D" | "SB" | "BB";

/** Reads the authoritative dealer/blind seats from the projection; never infers them. */
export function seatBadges(snapshot: GameSnapshot, seat: number): readonly SeatBadge[] {
  const badges: SeatBadge[] = [];
  if (seat === snapshot.dealerSeat) badges.push("D");
  if (seat === snapshot.smallBlindSeat) badges.push("SB");
  if (seat === snapshot.bigBlindSeat) badges.push("BB");
  return badges;
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
