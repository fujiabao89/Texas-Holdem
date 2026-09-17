import { and, asc, eq, ne } from "drizzle-orm";
import type { Database } from "../database";
import { gameSnapshots, handEvents, roomPlayers, rooms, tournamentPlayers, tournaments } from "../schema";
import type { RoomMemberCredentialRecord } from "./hand-history";

/** Internal records stay server-side; HTTP must project via a strict allow-list. */
export interface TournamentResultRecord {
  readonly tournament: Pick<typeof tournaments.$inferSelect, "id" | "championTournamentPlayerId" | "finishedAt" | "lastCommittedSequence">;
  readonly participants: readonly Pick<typeof tournamentPlayers.$inferSelect, "id" | "playerId" | "displayName" | "seatIndex" | "kind" | "pokerStatus" | "rank" | "finalStack" | "startingStack" | "forfeitedChips">[];
  readonly snapshot: Pick<typeof gameSnapshots.$inferSelect, "sequence" | "state" | "schemaVersion" | "engineVersion" | "stateChecksum"> | null;
  readonly terminalEvent: Pick<typeof handEvents.$inferSelect, "type" | "payload"> | null;
}
export type TournamentResultReadOutcome =
  | { readonly kind: "not-found" | "unauthorized" | "not-finished" }
  | { readonly kind: "result"; readonly record: TournamentResultRecord };
export interface TournamentResultReadRepository {
  read(
    tournamentId: string,
    now: number,
    authorize: (roomId: string, members: readonly RoomMemberCredentialRecord[]) => boolean,
  ): Promise<TournamentResultReadOutcome>;
}

/** Authorization and all result sources share one committed, read-only DB snapshot. */
export function createTournamentResultRepository(database: Database): TournamentResultReadRepository {
  return {
    read(tournamentId, now, authorize) {
      return database.db.transaction(async (tx): Promise<TournamentResultReadOutcome> => {
        const [tournament] = await tx.select({
          id: tournaments.id, roomId: tournaments.roomId, status: tournaments.status,
          championTournamentPlayerId: tournaments.championTournamentPlayerId,
          finishedAt: tournaments.finishedAt, retentionExpiresAt: tournaments.retentionExpiresAt,
          lastCommittedSequence: tournaments.lastCommittedSequence,
        }).from(tournaments).where(eq(tournaments.id, tournamentId));
        if (!tournament) return { kind: "not-found" };
        const members = await tx.select({
          playerId: roomPlayers.id, kind: roomPlayers.kind,
          tokenDigest: roomPlayers.tokenDigest, tokenKeyId: roomPlayers.tokenKeyId,
        }).from(roomPlayers).innerJoin(rooms, eq(rooms.id, roomPlayers.roomId)).where(and(
          eq(roomPlayers.roomId, tournament.roomId), eq(roomPlayers.status, "ACTIVE"),
          eq(roomPlayers.kind, "HUMAN"), ne(rooms.status, "CLOSED"),
        ));
        if (!authorize(tournament.roomId, members)) return { kind: "unauthorized" };
        if (tournament.retentionExpiresAt !== null && tournament.retentionExpiresAt.getTime() <= now) return { kind: "not-found" };
        if (tournament.status !== "FINISHED") return { kind: "not-finished" };
        const participants = await tx.select({
          id: tournamentPlayers.id, playerId: tournamentPlayers.playerId, displayName: tournamentPlayers.displayName,
          seatIndex: tournamentPlayers.seatIndex, kind: tournamentPlayers.kind, pokerStatus: tournamentPlayers.pokerStatus,
          rank: tournamentPlayers.rank, finalStack: tournamentPlayers.finalStack,
          startingStack: tournamentPlayers.startingStack, forfeitedChips: tournamentPlayers.forfeitedChips,
        }).from(tournamentPlayers).where(eq(tournamentPlayers.tournamentId, tournamentId)).orderBy(asc(tournamentPlayers.seatIndex));
        const [snapshot] = await tx.select({
          sequence: gameSnapshots.sequence, state: gameSnapshots.state,
          schemaVersion: gameSnapshots.schemaVersion, engineVersion: gameSnapshots.engineVersion,
          stateChecksum: gameSnapshots.stateChecksum,
        }).from(gameSnapshots).where(and(eq(gameSnapshots.tournamentId, tournamentId), eq(gameSnapshots.sequence, tournament.lastCommittedSequence)));
        const [terminalEvent] = await tx.select({ type: handEvents.type, payload: handEvents.payload })
          .from(handEvents).where(and(eq(handEvents.tournamentId, tournamentId), eq(handEvents.sequence, tournament.lastCommittedSequence)));
        return { kind: "result", record: { tournament, participants, snapshot: snapshot ?? null, terminalEvent: terminalEvent ?? null } };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
