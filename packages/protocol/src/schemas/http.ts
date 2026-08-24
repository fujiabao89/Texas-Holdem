import { z } from "zod";

import { GameEventMessageSchema } from "../events";
import { CardSchema, DecimalSequenceSchema, EpochMillisecondsSchema, OpaqueIdSchema, SafeIntegerSchema } from "./common";
import { RoomSnapshotSchema } from "./views";

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
