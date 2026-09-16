import type { GameSnapshot, RoomSnapshot, TournamentResult } from "@texas-holdem/protocol";

/**
 * Pure presentation model for the Game Result page (docs/05 §6.6). Rankings,
 * placement order and final chips all come from the server projection or the
 * authoritative persisted tournament result (TEX-54 / TEX-55); the UI only
 * arranges what the server authorizes.
 */

export interface ResultRow {
  readonly playerId: string;
  readonly displayName: string;
  readonly place: number;
  readonly tied: boolean;
  readonly champion: boolean;
  readonly finalChips: number;
}

export interface ChampionView {
  readonly hasChampion: boolean;
  readonly playerId: string | null;
  readonly displayName: string | null;
  readonly finalChips: number;
}

/** Rows in the server-given `displayOrder`; UI never re-sorts placements. */
export function resultRows(source: GameSnapshot | TournamentResult): readonly ResultRow[] {
  if ("championPlayerId" in source) {
    const players = new Map(source.players.map((player) => [player.playerId, player]));
    return [...source.rankings]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((ranking) => {
        const player = players.get(ranking.playerId);
        return {
          playerId: ranking.playerId,
          displayName: player?.displayName ?? ranking.playerId,
          place: ranking.placement.from,
          tied: ranking.placement.from !== ranking.placement.to,
          champion: source.championPlayerId !== null && ranking.playerId === source.championPlayerId,
          finalChips: player?.finalStack ?? 0,
        };
      });
  }

  const players = new Map(source.players.map((player) => [player.playerId, player]));
  return [...source.rankings]
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

/** Extracts champion information, respecting championless finishes (ADR-0002). */
export function resultChampion(source: GameSnapshot | TournamentResult): ChampionView {
  if ("championPlayerId" in source) {
    if (source.championPlayerId === null) {
      return { hasChampion: false, playerId: null, displayName: null, finalChips: 0 };
    }
    const player = source.players.find((p) => p.playerId === source.championPlayerId);
    return {
      hasChampion: true,
      playerId: source.championPlayerId,
      displayName: player?.displayName ?? source.championPlayerId,
      finalChips: player?.finalStack ?? 0,
    };
  }

  const rows = resultRows(source);
  const championRow = rows.find((r) => r.champion);
  if (!championRow) return { hasChampion: false, playerId: null, displayName: null, finalChips: 0 };
  return {
    hasChampion: true,
    playerId: championRow.playerId,
    displayName: championRow.displayName,
    finalChips: championRow.finalChips,
  };
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
 * Legacy check: indicates whether the in-memory game snapshot cannot arrive via
 * the WebSocket connection (because room.activeTournamentId is null). Under TEX-55,
 * the page falls back to the authoritative HTTP endpoint instead of showing an
 * immediate terminal failure.
 */
export function resultSnapshotUnreachable(
  room: RoomSnapshot | null,
  roomId: string,
  game: GameSnapshot | null,
): boolean {
  return room !== null && room.roomId === roomId && room.activeTournamentId === null && game === null;
}
