import { z } from "zod";

import { CommandResultPayloadSchema } from "../commands";
import { ProtocolErrorSchema } from "../errors";
import {
  ActionSourceSchema,
  CardSchema,
  EpochMillisecondsSchema,
  EventSequenceSchema,
  HandRankSchema,
  OpaqueIdSchema,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  SafeIntegerSchema,
  SeatSchema,
} from "../schemas/common";
import { GameSnapshotSchema, PlayerViewPatchSchema, ReconnectResultSchema, RoomSnapshotSchema } from "../schemas/views";

const PlayerAndSeatSchema = { playerId: OpaqueIdSchema, seat: SeatSchema };
const ActionActorSchema = { ...PlayerAndSeatSchema, source: ActionSourceSchema };

export const GameEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("HAND_STARTED"), payload: z.strictObject({ handNumber: z.number().int().min(1), dealerSeat: SeatSchema, smallBlindSeat: SeatSchema, bigBlindSeat: SeatSchema, blindLevel: z.number().int().min(0) }) }),
  z.strictObject({ type: z.literal("BLIND_POSTED"), payload: z.strictObject({ ...PlayerAndSeatSchema, blindType: z.enum(["SMALL_BLIND", "BIG_BLIND", "ANTE"]), amount: SafeIntegerSchema, betTo: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("DEAL_HOLE_CARD"), payload: z.strictObject({ ...PlayerAndSeatSchema, cardIndex: z.union([z.literal(0), z.literal(1)]), card: CardSchema.optional() }) }),
  z.strictObject({ type: z.literal("BURN_CARD"), payload: z.strictObject({ street: z.enum(["FLOP", "TURN", "RIVER"]) }) }),
  z.strictObject({ type: z.literal("FLOP_DEALT"), payload: z.strictObject({ cards: z.array(CardSchema).length(3) }) }),
  z.strictObject({ type: z.literal("TURN_DEALT"), payload: z.strictObject({ card: CardSchema }) }),
  z.strictObject({ type: z.literal("RIVER_DEALT"), payload: z.strictObject({ card: CardSchema }) }),
  z.strictObject({ type: z.literal("PLAYER_CHECKED"), payload: z.strictObject(ActionActorSchema) }),
  z.strictObject({ type: z.literal("PLAYER_CALLED"), payload: z.strictObject({ ...ActionActorSchema, amount: SafeIntegerSchema, betTo: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("PLAYER_BET"), payload: z.strictObject({ ...ActionActorSchema, amount: SafeIntegerSchema, betTo: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("PLAYER_ALL_IN"), payload: z.strictObject({ ...ActionActorSchema, amount: SafeIntegerSchema, betTo: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("PLAYER_RAISED"), payload: z.strictObject({ ...ActionActorSchema, amount: SafeIntegerSchema, raiseTo: SafeIntegerSchema, isFullRaise: z.boolean() }) }),
  z.strictObject({ type: z.literal("PLAYER_FOLDED"), payload: z.strictObject(ActionActorSchema) }),
  z.strictObject({ type: z.literal("SHOWDOWN_STARTED"), payload: z.strictObject({ contenderPlayerIds: z.array(OpaqueIdSchema).min(1).max(10) }) }),
  z.strictObject({ type: z.literal("PLAYER_REVEALED"), payload: z.strictObject({ ...PlayerAndSeatSchema, cards: z.array(CardSchema).length(2), handRank: HandRankSchema }) }),
  z.strictObject({ type: z.literal("UNCALLED_BET_RETURNED"), payload: z.strictObject({ ...PlayerAndSeatSchema, amount: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("POT_AWARDED"), payload: z.strictObject({ potIndex: z.number().int().min(0), potAmount: SafeIntegerSchema, awards: z.array(z.strictObject({ playerId: OpaqueIdSchema, amount: SafeIntegerSchema })).min(1).max(10), winningHandRank: HandRankSchema.nullable() }).superRefine((value, context) => {
    if (value.awards.reduce((sum, award) => sum + award.amount, 0) !== value.potAmount) context.addIssue({ code: "custom", message: "awards must total potAmount" });
  }) }),
  z.strictObject({ type: z.literal("PLAYER_ELIMINATED"), payload: z.strictObject({ playerId: OpaqueIdSchema, finishPosition: z.number().int().min(1), tied: z.boolean() }) }),
  z.strictObject({ type: z.literal("PLAYER_WITHDRAWN"), payload: z.strictObject({ ...PlayerAndSeatSchema, forfeitedChips: SafeIntegerSchema }) }),
  z.strictObject({ type: z.literal("TOURNAMENT_FINISHED"), payload: z.strictObject({ winnerPlayerId: OpaqueIdSchema, rankings: z.array(z.strictObject({ playerId: OpaqueIdSchema, finishPosition: z.number().int().min(1), tied: z.boolean() })).min(1).max(10) }) }),
]);

const serverMessage = <T extends z.ZodType>(type: string, payload: T) => z.strictObject({
  type: z.literal(type),
  protocolVersion: ProtocolVersionSchema,
  serverTime: EpochMillisecondsSchema,
  payload,
});

export const GameEventMessageSchema = serverMessage("GAME_EVENT", z.strictObject({
  tournamentId: OpaqueIdSchema,
  sequence: EventSequenceSchema,
  handId: OpaqueIdSchema.nullable(),
  event: GameEventSchema,
  patch: PlayerViewPatchSchema,
}));
export const ServerMessageSchema = z.discriminatedUnion("type", [
  serverMessage("RECONNECT_RESULT", ReconnectResultSchema),
  serverMessage("ROOM_SNAPSHOT", RoomSnapshotSchema),
  serverMessage("GAME_SNAPSHOT", GameSnapshotSchema),
  GameEventMessageSchema,
  serverMessage("CLOCK_UPDATED", z.strictObject({ tournamentId: OpaqueIdSchema, handId: OpaqueIdSchema.nullable(), currentActorPlayerId: OpaqueIdSchema.nullable(), actionDeadline: EpochMillisecondsSchema.nullable(), timeBankRemainingMs: SafeIntegerSchema })),
  serverMessage("COMMAND_RESULT", CommandResultPayloadSchema),
  serverMessage("RESYNC_REQUIRED", z.strictObject({ tournamentId: OpaqueIdSchema, reason: z.enum(["BACKPRESSURE", "GAP", "INVALID_EVENT", "STALE_ACTION"]) })),
  serverMessage("SESSION_REPLACED", z.strictObject({})),
  serverMessage("ERROR", ProtocolErrorSchema),
]);

export const CloseCodeSchema = z.union([z.literal(4000), z.literal(4001), z.literal(4003), z.literal(4008)]);
export const CLOSE_CODES = { PROTOCOL_ERROR: 4000, SESSION_REPLACED: 4001, AUTH_FAILED: 4003, HEARTBEAT_TIMEOUT: 4008 } as const;

export function validateServerMessage(value: unknown):
  | { success: true; data: z.infer<typeof ServerMessageSchema> }
  | { success: false; errorCode: "UNSUPPORTED_PROTOCOL_VERSION" | "INVALID_MESSAGE" } {
  if (typeof value === "object" && value !== null && "protocolVersion" in value && (value as Record<string, unknown>).protocolVersion !== PROTOCOL_VERSION) {
    return { success: false, errorCode: "UNSUPPORTED_PROTOCOL_VERSION" };
  }
  const result = ServerMessageSchema.safeParse(value);
  return result.success ? result : { success: false, errorCode: "INVALID_MESSAGE" };
}

export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventMessage = z.infer<typeof GameEventMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type CloseCode = z.infer<typeof CloseCodeSchema>;
