import { z } from "zod";

import { ErrorCodeSchema, ProtocolErrorSchema } from "../errors";
import {
  ActionIdSchema,
  DecimalSequenceSchema,
  DisplayNameSchema,
  InviteCodeSchema,
  OpaqueIdSchema,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  PlayerTokenSchema,
  RequestIdSchema,
  SafeIntegerSchema,
  SeatSchema,
  TournamentConfigSchema,
} from "../schemas/common";

const SubmitActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("FOLD") }),
  z.strictObject({ type: z.literal("CHECK") }),
  z.strictObject({ type: z.literal("CALL") }),
  z.strictObject({ type: z.literal("BET"), betTo: SafeIntegerSchema }),
  z.strictObject({ type: z.literal("RAISE"), raiseTo: SafeIntegerSchema }),
  z.strictObject({ type: z.literal("ALL_IN") }),
]);

const AuthenticateCommandSchema = z.strictObject({
  type: z.literal("AUTHENTICATE"),
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  payload: z.strictObject({ roomId: OpaqueIdSchema, playerToken: PlayerTokenSchema }),
});
const SetReadyCommandSchema = z.strictObject({
  type: z.literal("SET_READY"),
  requestId: RequestIdSchema,
  payload: z.strictObject({ ready: z.boolean() }),
});
const SubmitActionCommandSchema = z.strictObject({
  type: z.literal("SUBMIT_ACTION"),
  requestId: RequestIdSchema,
  payload: z.strictObject({
    tournamentId: OpaqueIdSchema,
    actionId: ActionIdSchema,
    expectedSequence: DecimalSequenceSchema,
    action: SubmitActionSchema,
  }),
});
const UseTimeBankCommandSchema = z.strictObject({
  type: z.literal("USE_TIME_BANK"),
  requestId: RequestIdSchema,
  payload: z.strictObject({ tournamentId: OpaqueIdSchema, expectedSequence: DecimalSequenceSchema }),
});
const RequestSnapshotCommandSchema = z.strictObject({
  type: z.literal("REQUEST_SNAPSHOT"),
  requestId: RequestIdSchema,
  payload: z.strictObject({
    tournamentId: OpaqueIdSchema,
    lastSequence: DecimalSequenceSchema,
    reason: z.enum(["GAP", "INVALID_EVENT", "STALE_ACTION", "MANUAL"]),
  }),
});
const LeaveRoomCommandSchema = z.strictObject({
  type: z.literal("LEAVE_ROOM"),
  requestId: RequestIdSchema,
  payload: z.strictObject({}),
});

export const ClientCommandSchema = z.discriminatedUnion("type", [
  AuthenticateCommandSchema,
  SetReadyCommandSchema,
  SubmitActionCommandSchema,
  UseTimeBankCommandSchema,
  RequestSnapshotCommandSchema,
  LeaveRoomCommandSchema,
]);

export const CreateRoomRequestSchema = z.strictObject({ displayName: DisplayNameSchema, config: TournamentConfigSchema });
export const JoinRoomRequestSchema = z.strictObject({ inviteCode: InviteCodeSchema, displayName: DisplayNameSchema });
export const RoomOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("UPDATE_CONFIG"), config: TournamentConfigSchema }),
  z.strictObject({ type: z.literal("KICK_PLAYER"), targetPlayerId: OpaqueIdSchema }),
  z.strictObject({ type: z.literal("CHANGE_SEAT"), seat: SeatSchema.nullable() }),
]);
export const UpdateRoomRequestSchema = z.strictObject({ expectedRoomRevision: DecimalSequenceSchema, operation: RoomOperationSchema });
export const StartTournamentRequestSchema = z.strictObject({ expectedRoomRevision: DecimalSequenceSchema });
export const LeaveRoomRequestSchema = z.strictObject({});
export const HandHistoryQuerySchema = z.strictObject({ cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const IdempotencyKeySchema = RequestIdSchema;

export const CommandResultPayloadSchema = z.strictObject({
  requestId: RequestIdSchema,
  actionId: ActionIdSchema.optional(),
  status: z.enum(["APPLIED", "REJECTED"]),
  duplicate: z.boolean(),
  appliedSequence: DecimalSequenceSchema.optional(),
  error: ProtocolErrorSchema.optional(),
}).superRefine((value, context) => {
  if (value.status === "APPLIED" && value.error !== undefined) context.addIssue({ code: "custom", message: "applied command cannot include error" });
  if (value.status === "REJECTED" && value.error === undefined) context.addIssue({ code: "custom", message: "rejected command requires error" });
});

export function validateClientCommand(value: unknown):
  | { success: true; data: z.infer<typeof ClientCommandSchema> }
  | { success: false; errorCode: z.infer<typeof ErrorCodeSchema> } {
  if (typeof value === "object" && value !== null && "type" in value && (value as Record<string, unknown>).type === "AUTHENTICATE") {
    const version = (value as Record<string, unknown>).protocolVersion;
    if (version !== PROTOCOL_VERSION) return { success: false, errorCode: "UNSUPPORTED_PROTOCOL_VERSION" };
  }
  const result = ClientCommandSchema.safeParse(value);
  return result.success ? result : { success: false, errorCode: "INVALID_MESSAGE" };
}

export type ClientCommand = z.infer<typeof ClientCommandSchema>;
export type SubmitAction = z.infer<typeof SubmitActionSchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;
export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequestSchema>;
export type StartTournamentRequest = z.infer<typeof StartTournamentRequestSchema>;
export type HandHistoryQuery = z.infer<typeof HandHistoryQuerySchema>;
export type CommandResultPayload = z.infer<typeof CommandResultPayloadSchema>;
