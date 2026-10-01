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

/** The viewer always sits at the bottom centre; opponents retain clockwise order. */
const VIEWER_SEAT_SLOT = 5;

export type TableLayout = "2" | "6" | "10";

export function tableLayout(playerCount: number): TableLayout {
  return playerCount <= 2 ? "2" : playerCount <= 6 ? "6" : "10";
}

// Clockwise visual slots, starting at the viewer. Eliminated/withdrawn players
// stay in the full tournament roster and retain their places between hands.
const slotsByPlayerCount: Readonly<Record<number, readonly number[]>> = {
  1: [5], 2: [5, 0], 3: [5, 9, 1], 4: [5, 7, 0, 3],
  5: [5, 7, 9, 1, 3], 6: [5, 7, 9, 0, 1, 3],
  7: [5, 6, 8, 9, 1, 2, 4],
  8: [5, 6, 7, 9, 0, 1, 3, 4],
  9: [5, 6, 7, 8, 9, 1, 2, 3, 4],
  10: [5, 6, 7, 8, 9, 0, 1, 2, 3, 4],
};

/** Presentation only: compact sparse physical seats without changing their order. */
export function tableSeatSlots(snapshot: GameSnapshot): ReadonlyArray<number | null> {
  const slots = Array<number | null>(10).fill(null);
  const viewer = snapshot.players.find((player) => player.playerId === snapshot.viewer.playerId);
  if (viewer === undefined) return slots;
  const template = slotsByPlayerCount[snapshot.players.length] ?? [VIEWER_SEAT_SLOT];
  const ordered = [...snapshot.players].sort((a, b) => (a.seat - viewer.seat + 10) % 10 - (b.seat - viewer.seat + 10) % 10);
  for (const [index, player] of ordered.entries()) {
    slots[player.seat] = template[index] ?? null;
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
