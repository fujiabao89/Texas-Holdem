import { z } from "zod";

import { DecimalSequenceSchema, OpaqueIdSchema, SafeIntegerSchema } from "../schemas/common";

export const ERROR_CODES = [
  "INVALID_MESSAGE", "UNSUPPORTED_PROTOCOL_VERSION", "AUTH_REQUIRED", "AUTH_FAILED", "FORBIDDEN", "SESSION_REPLACED",
  "RATE_LIMITED", "ROOM_NOT_FOUND", "INVALID_INVITE_CODE", "INVITE_EXPIRED", "ROOM_FULL", "NICKNAME_INVALID",
  "NICKNAME_TAKEN", "ROOM_LOCKED", "NOT_HOST", "PLAYER_NOT_SEATED", "STALE_ROOM_STATE", "TOURNAMENT_NOT_ACTIVE",
  "NOT_YOUR_TURN", "INVALID_ACTION", "INVALID_AMOUNT", "ACTION_TIMEOUT", "STALE_GAME_STATE", "IDEMPOTENCY_KEY_REUSE",
  "TIME_BANK_DISABLED", "TIME_BANK_EMPTY", "TIME_BANK_NOT_AVAILABLE", "GAME_UNAVAILABLE", "INTERNAL_ERROR",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);

const ErrorDetailValueSchema = z.union([z.string().max(128), SafeIntegerSchema, z.boolean(), z.null()]);
const ErrorDetailsSchema = z.record(z.string(), ErrorDetailValueSchema).superRefine((details, context) => {
  for (const key of Object.keys(details)) {
    if (!["currentSequence", "currentRoomRevision", "minBetTo", "minRaiseTo", "maxRaiseTo", "allInTo", "retryAfterMs"].includes(key)) {
      context.addIssue({ code: "custom", message: "unsafe error detail key" });
    }
  }
});

export const ProtocolErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(256),
  retryable: z.boolean(),
  traceId: OpaqueIdSchema,
  details: ErrorDetailsSchema.optional(),
}).superRefine((error, context) => {
  const allowed = allowedDetailKeys(error.code);
  for (const key of Object.keys(error.details ?? {})) {
    if (!allowed.includes(key)) {
      context.addIssue({ code: "custom", message: "detail key is not allowed for error code" });
    }
  }
  if (error.details?.currentSequence !== undefined && !DecimalSequenceSchema.safeParse(error.details.currentSequence).success) {
    context.addIssue({ code: "custom", message: "currentSequence must be a decimal uint64 string" });
  }
});

export const ErrorEnvelopeSchema = z.strictObject({ error: ProtocolErrorSchema });

const SAFE_MESSAGES: Record<z.infer<typeof ErrorCodeSchema>, string> = Object.fromEntries(
  ERROR_CODES.map((code) => [code, code.toLowerCase().replaceAll("_", " ")]),
) as Record<z.infer<typeof ErrorCodeSchema>, string>;

function allowedDetailKeys(code: z.infer<typeof ErrorCodeSchema>): readonly string[] {
  switch (code) {
    case "RATE_LIMITED": return ["retryAfterMs"];
    case "STALE_GAME_STATE":
    case "ACTION_TIMEOUT": return ["currentSequence"];
    case "STALE_ROOM_STATE": return ["currentRoomRevision"];
    case "INVALID_AMOUNT": return ["minBetTo", "minRaiseTo", "maxRaiseTo", "allInTo"];
    case "GAME_UNAVAILABLE": return ["retryAfterMs"];
    default: return [];
  }
}

export function createProtocolError(
  code: z.infer<typeof ErrorCodeSchema>,
  traceId: z.infer<typeof OpaqueIdSchema>,
  options: { retryable?: boolean; details?: Record<string, string | number | boolean | null> } = {},
): z.infer<typeof ProtocolErrorSchema> {
  return ProtocolErrorSchema.parse({ code, message: SAFE_MESSAGES[code], traceId, retryable: options.retryable ?? false, details: options.details });
}

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
