import { z } from "zod";
import {
  SafeIntegerSchema, SeatSchema, TournamentResultResponseSchema,
  type TournamentResultResponse,
} from "@texas-holdem/protocol";
import { sha256Checksum, stableStringify } from "../infrastructure/persistence/checksum";
import type { TournamentResultRecord } from "../infrastructure/persistence/repositories/tournament-result";
import { RoomDomainError } from "../rooms/room-errors";
import { ENGINE_VERSION, SCHEMA_VERSION } from "../tournaments/tournament-persistence";

// These internal readers intentionally strip all unrelated private state; wire
// objects below are rebuilt field by field and validated by the shared schema.
const FinishSchema = z.object({
  placementRange: z.object({ from: z.number().int().min(1).max(10), to: z.number().int().min(1).max(10) }),
  displayOrder: z.number().int().min(1).max(10),
});
const StandingSchema = FinishSchema.extend({ seatIndex: SeatSchema });
const FinishedStateSchema = z.object({
  phase: z.literal("finished"), handInProgress: z.literal(false),
  nextSequence: SafeIntegerSchema,
  champion: SeatSchema.nullable(),
  initialTotalChips: SafeIntegerSchema, forfeitedChips: SafeIntegerSchema,
  participants: z.array(z.object({
    seatIndex: SeatSchema, name: z.string(), kind: z.enum(["human", "bot"]),
    status: z.enum(["ACTIVE", "ELIMINATED", "WITHDRAWN"]),
    chips: SafeIntegerSchema, startingStack: SafeIntegerSchema, finish: FinishSchema.optional(),
  })).min(2).max(10),
  finalStandings: z.array(StandingSchema).max(10),
});
const TerminalEventSchema = z.object({
  championSeat: SeatSchema.nullable(), finalStandings: z.array(StandingSchema).max(10),
});
type DurableStanding = z.infer<typeof StandingSchema>;

function requireComplete(condition: boolean): asserts condition {
  if (!condition) throw new RoomDomainError("TOURNAMENT_RESULT_INCOMPLETE");
}

/** Validate durable facts without restoring an engine or exposing its private state. */
export function projectTournamentResult(record: TournamentResultRecord): TournamentResultResponse {
  try {
    const { tournament, participants, snapshot, terminalEvent } = record;
    requireComplete(snapshot !== null && terminalEvent !== null && tournament.finishedAt !== null);
    requireComplete(snapshot.schemaVersion === SCHEMA_VERSION && snapshot.engineVersion === ENGINE_VERSION);
    requireComplete(snapshot.sequence === tournament.lastCommittedSequence && snapshot.sequence > 0n);
    // Drizzle decodes the production bundle JSON text stored in jsonb into an object.
    requireComplete(sha256Checksum(snapshot.state).equals(snapshot.stateChecksum));
    const state = FinishedStateSchema.parse(snapshot.state);
    requireComplete(BigInt(state.nextSequence) === snapshot.sequence);
    requireComplete(terminalEvent.type === "TOURNAMENT_FINISHED");
    const event = TerminalEventSchema.parse(terminalEvent.payload);
    requireComplete(event.championSeat === state.champion && stableStringify(event.finalStandings) === stableStringify(state.finalStandings));
    requireComplete(participants.length === state.participants.length);
    const bySeat = new Map(participants.map((p) => [p.seatIndex, p]));
    requireComplete(bySeat.size === participants.length && new Set(state.participants.map((p) => p.seatIndex)).size === participants.length);
    const standings = new Map(state.finalStandings.map((standing) => [standing.seatIndex, standing]));
    requireComplete(standings.size === state.finalStandings.length);
    let startingTotal = 0n;
    let finalTotal = 0n;
    let forfeitedTotal = 0n;
    for (const player of state.participants) {
      const locked = bySeat.get(player.seatIndex);
      requireComplete(locked !== undefined && locked.finalStack !== null);
      requireComplete(locked.displayName === player.name && locked.kind.toLowerCase() === player.kind);
      requireComplete(locked.pokerStatus === player.status && locked.finalStack === BigInt(player.chips) && locked.startingStack === BigInt(player.startingStack));
      startingTotal += locked.startingStack;
      finalTotal += locked.finalStack;
      forfeitedTotal += locked.forfeitedChips;
      const standing = standings.get(player.seatIndex);
      if (player.status === "WITHDRAWN") {
        requireComplete(locked.rank === null && standing === undefined && player.finish === undefined);
      } else {
        requireComplete(standing !== undefined && player.finish !== undefined);
        requireComplete(stableStringify(player.finish) === stableStringify({ placementRange: standing.placementRange, displayOrder: standing.displayOrder }));
        requireComplete(locked.rank === standing.placementRange.from + standing.displayOrder - 1);
      }
    }
    requireComplete(startingTotal === BigInt(state.initialTotalChips) && forfeitedTotal === BigInt(state.forfeitedChips));
    requireComplete(finalTotal + forfeitedTotal === startingTotal);
    const champion = state.champion === null ? null : bySeat.get(state.champion);
    requireComplete(champion !== undefined);
    requireComplete((champion?.id ?? null) === tournament.championTournamentPlayerId);
    const publicStandings = compactPublicStandings(state.finalStandings);
    return TournamentResultResponseSchema.parse({ data: {
      tournamentId: tournament.id, status: "FINISHED", championPlayerId: champion?.playerId ?? null,
      finishedAt: tournament.finishedAt.getTime(),
      rankings: publicStandings.map((standing) => ({
        playerId: bySeat.get(standing.seatIndex)?.playerId,
        placement: { from: standing.placementRange.from, to: standing.placementRange.to },
        displayOrder: standing.displayOrder,
      })),
      players: participants.map((player) => ({
        playerId: player.playerId, displayName: player.displayName, seat: player.seatIndex,
        kind: player.kind, pokerStatus: player.pokerStatus, finalStack: Number(player.finalStack),
      })),
    } });
  } catch {
    // Never include a Zod issue, row, checksum, or raw exception in the response/log.
    throw new RoomDomainError("TOURNAMENT_RESULT_INCOMPLETE");
  }
}

/** 排除 WITHDRAWN 后，把持久化的原桌名次组压缩为公开连续 1..N；并列组不拆分。 */
function compactPublicStandings(standings: readonly DurableStanding[]): readonly DurableStanding[] {
  const groups = new Map<string, DurableStanding[]>();
  for (const standing of standings) {
    const key = `${standing.placementRange.from}:${standing.placementRange.to}`;
    groups.set(key, [...(groups.get(key) ?? []), standing]);
  }
  const compact = new Map<number, DurableStanding>();
  let nextRank = 1;
  for (const group of [...groups.values()].sort((left, right) => left[0]!.placementRange.from - right[0]!.placementRange.from || left[0]!.placementRange.to - right[0]!.placementRange.to)) {
    const ordered = [...group].sort((left, right) => left.displayOrder - right.displayOrder);
    requireComplete(ordered.every((standing, index) => standing.displayOrder === index + 1));
    const placementRange = { from: nextRank, to: nextRank + ordered.length - 1 };
    ordered.forEach((standing, index) => compact.set(standing.seatIndex, { ...standing, placementRange, displayOrder: index + 1 }));
    nextRank += ordered.length;
  }
  return standings.map((standing) => compact.get(standing.seatIndex)!);
}
