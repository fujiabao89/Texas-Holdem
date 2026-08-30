import type { GameSnapshot, RoomSnapshot } from "@texas-holdem/protocol";

/**
 * Pure presentation model for the Game Result page (docs/05 §6.6). Rankings,
 * placement order and final chips all come from the server projection; the UI
 * only arranges what the snapshot already authorizes.
 */

export interface ResultRow {
  readonly playerId: string;
  readonly displayName: string;
  readonly place: number;
  readonly tied: boolean;
  readonly champion: boolean;
  readonly finalChips: number;
}

/** Rows in the server-given `displayOrder`; UI never re-sorts placements. */
export function resultRows(game: GameSnapshot): readonly ResultRow[] {
  const players = new Map(game.players.map((player) => [player.playerId, player]));
  return [...game.rankings]
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((ranking) => {
      const player = players.get(ranking.playerId);
      return {
        playerId: ranking.playerId,
        displayName: player?.displayName ?? ranking.playerId,
        place: ranking.placement.from,
        tied: ranking.placement.from !== ranking.placement.to,
        champion: ranking.placement.from === 1,
        finalChips: player?.stack ?? 0,
      };
    });
}

/** A result page only exists for the exact finished tournament in the URL. */
export function resultAvailableFor(game: GameSnapshot | null, tournamentId: string): boolean {
  return game !== null && game.tournamentId === tournamentId && game.tournamentStatus === "FINISHED";
}

/** The room is playable for "play again" only through the host's start flow. */
export function canPlayAgain(roomStatus: string, isHost: boolean): boolean {
  return isHost && roomStatus !== "CLOSED";
}

/**
 * The room is loaded with no active tournament and no game snapshot: once a
 * tournament finishes the server clears `activeTournamentId`, so the auth /
 * reconnect answer always carries `gameSnapshot: null` and the requested
 * result snapshot will never arrive on this connection (docs/02 §10). The
 * page must show an explicit unavailable state instead of waiting forever.
 */
export function resultSnapshotUnreachable(
  room: RoomSnapshot | null,
  roomId: string,
  game: GameSnapshot | null,
): boolean {
  return room !== null && room.roomId === roomId && room.activeTournamentId === null && game === null;
}
