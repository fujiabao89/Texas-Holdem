import { z } from "zod";

import { GameEventMessageSchema } from "../events";
import { CardSchema, DecimalSequenceSchema, DisplayNameSchema, EpochMillisecondsSchema, OpaqueIdSchema, SafeIntegerSchema, SeatSchema } from "./common";
import { RankingViewSchema, RoomSnapshotSchema } from "./views";

/** Strict `{ data }` wrapper required by every successful HTTP response. */
export const HttpDataEnvelopeSchema = <T extends z.ZodType>(data: T) => z.strictObject({ data });

const PlayerSessionSchema = z.strictObject({
  roomId: OpaqueIdSchema,
  playerId: OpaqueIdSchema,
  playerToken: z.string().min(43).max(1024),
  roomSnapshot: RoomSnapshotSchema,
});
export const CreateRoomResponseSchema = HttpDataEnvelopeSchema(PlayerSessionSchema);
export const JoinRoomResponseSchema = HttpDataEnvelopeSchema(PlayerSessionSchema);

/** Shared success envelopes for the protected Lobby control-plane endpoints. */
export const UpdateRoomResponseSchema = HttpDataEnvelopeSchema(z.strictObject({
  roomSnapshot: RoomSnapshotSchema,
}));
export const StartTournamentResponseSchema = HttpDataEnvelopeSchema(z.strictObject({
  tournamentId: OpaqueIdSchema,
  roomSnapshot: RoomSnapshotSchema,
}));
export const LeaveRoomResponseSchema = HttpDataEnvelopeSchema(z.strictObject({
  roomSnapshot: RoomSnapshotSchema,
}));

const HandHistoryItemSchema = z.strictObject({
  handId: OpaqueIdSchema,
  handNumber: z.number().int().min(1),
  startedAt: EpochMillisecondsSchema,
  endedAt: EpochMillisecondsSchema,
  smallBlind: SafeIntegerSchema,
  bigBlind: SafeIntegerSchema,
  communityCards: z.array(CardSchema).max(5),
  endReason: z.string().min(1).max(64),
  potTotal: SafeIntegerSchema,
  winnerPlayerIds: z.array(OpaqueIdSchema).min(1).max(10),
});
export const HandHistoryListResponseSchema = HttpDataEnvelopeSchema(z.strictObject({
  tournamentId: OpaqueIdSchema,
  items: z.array(HandHistoryItemSchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
}));
export const HandHistoryDetailResponseSchema = HttpDataEnvelopeSchema(z.strictObject({
  tournamentId: OpaqueIdSchema,
  handId: OpaqueIdSchema,
  startSequence: DecimalSequenceSchema,
  endSequence: DecimalSequenceSchema,
  events: z.array(GameEventMessageSchema),
}));

export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;
export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;
export type UpdateRoomResponse = z.infer<typeof UpdateRoomResponseSchema>;
export type StartTournamentResponse = z.infer<typeof StartTournamentResponseSchema>;
export type LeaveRoomResponse = z.infer<typeof LeaveRoomResponseSchema>;
export type HandHistoryListResponse = z.infer<typeof HandHistoryListResponseSchema>;
export type HandHistoryDetailResponse = z.infer<typeof HandHistoryDetailResponseSchema>;

/** Strict input contract for the persisted result GET endpoint (no query identity). */
export const TournamentResultParamsSchema = z.strictObject({ tournamentId: z.uuid() });
export const TournamentResultQuerySchema = z.strictObject({});

/** Persisted public result; withdrawn players have no invented ranking. */
export const TournamentResultSchema = z.strictObject({
  tournamentId: OpaqueIdSchema,
  status: z.literal("FINISHED"),
  championPlayerId: OpaqueIdSchema.nullable(),
  rankings: z.array(RankingViewSchema).max(10),
  players: z.array(z.strictObject({
    playerId: OpaqueIdSchema,
    displayName: DisplayNameSchema,
    seat: SeatSchema,
    kind: z.enum(["HUMAN", "BOT"]),
    pokerStatus: z.enum(["ACTIVE", "ELIMINATED", "WITHDRAWN"]),
    finalStack: SafeIntegerSchema,
  })).min(2).max(10),
  finishedAt: EpochMillisecondsSchema,
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "inconsistent tournament result" });
  const players = new Map(value.players.map((player) => [player.playerId, player]));
  const rankings = new Map(value.rankings.map((ranking) => [ranking.playerId, ranking]));
  if (players.size !== value.players.length || new Set(value.players.map((p) => p.seat)).size !== value.players.length || rankings.size !== value.rankings.length) invalid();
  const occupied = new Set<number>();
  for (const ranking of value.rankings) {
    const player = players.get(ranking.playerId);
    const { from, to } = ranking.placement;
    const rank = from + ranking.displayOrder - 1;
    if (!player || player.pokerStatus === "WITHDRAWN" || to > value.players.length || rank > to || occupied.has(rank)) invalid();
    occupied.add(rank);
    const group = value.rankings.filter((r) => r.placement.from === from && r.placement.to === to);
    if (group.length !== to - from + 1) invalid();
  }
  for (const player of value.players) {
    if ((player.pokerStatus !== "WITHDRAWN") !== rankings.has(player.playerId)) invalid();
    if (player.pokerStatus !== "ACTIVE" && player.finalStack !== 0) invalid();
    if ((player.pokerStatus === "ACTIVE") !== (player.playerId === value.championPlayerId)) invalid();
  }
  if (value.championPlayerId !== null) {
    const champion = rankings.get(value.championPlayerId);
    if (!players.has(value.championPlayerId) || !champion || champion.placement.from !== 1 || champion.placement.to !== 1 || champion.displayOrder !== 1) invalid();
  }
});
export const TournamentResultResponseSchema = HttpDataEnvelopeSchema(TournamentResultSchema);
export type TournamentResult = z.infer<typeof TournamentResultSchema>;
export type TournamentResultResponse = z.infer<typeof TournamentResultResponseSchema>;
