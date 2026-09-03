import { z } from "zod";

/** Wire major version. A different major version is never parsed optimistically. */
export const PROTOCOL_VERSION = 3 as const;

const UINT64_MAX = BigInt("18446744073709551615");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const OpaqueIdSchema = z.string().min(1).max(128).regex(OPAQUE_ID);
export const RequestIdSchema = z.string().regex(UUID_V4);
export const ActionIdSchema = RequestIdSchema;
export const PlayerTokenSchema = z.string().min(43).max(1024);
export const InviteCodeSchema = z.string().length(6).regex(/^[A-HJ-KM-NP-Z2-9]+$/);
export const DisplayNameSchema = z.string().refine((value) => value === value.normalize("NFC").trim(), {
  message: "displayName must be trimmed NFC text",
}).refine((value) => {
  const codePointLength = Array.from(value).length;
  return codePointLength >= 2 && codePointLength <= 16;
}, { message: "displayName must contain 2 to 16 Unicode code points" });
export const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).finite();
export const PositiveSafeIntegerSchema = SafeIntegerSchema.min(1);
export const SeatSchema = z.number().int().min(0).max(9);
export const EpochMillisecondsSchema = SafeIntegerSchema;
export const DecimalSequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(
  (value) => BigInt(value) <= UINT64_MAX,
  { message: "sequence must fit uint64" },
);
export const EventSequenceSchema = DecimalSequenceSchema.refine((value) => value !== "0", {
  message: "event sequence must be positive",
});

export const CardSchema = z.strictObject({
  rank: z.enum(["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]),
  suit: z.enum(["CLUBS", "DIAMONDS", "HEARTS", "SPADES"]),
});

export const ActionSourceSchema = z.enum(["HUMAN_SOCKET", "BOT_CONTROLLER", "SYSTEM_TIMER"]);
export const StreetSchema = z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]);
export const HandPhaseSchema = z.enum(["PREFLOP", "FLOP", "TURN", "RIVER", "HAND_END"]);
export const PokerStatusSchema = z.enum(["ACTIVE", "EXIT_PENDING", "WITHDRAWN", "ELIMINATED"]);
export const TournamentStatusSchema = z.enum(["RUNNING", "FINISHED"]);
export const HandRankSchema = z.strictObject({
  category: z.enum([
    "HIGH_CARD",
    "ONE_PAIR",
    "TWO_PAIR",
    "THREE_OF_A_KIND",
    "STRAIGHT",
    "FLUSH",
    "FULL_HOUSE",
    "FOUR_OF_A_KIND",
    "STRAIGHT_FLUSH",
  ]),
  tiebreakRanks: z.array(CardSchema.shape.rank).min(1).max(5),
  /** Server-adjudicated public cards; web clients must never derive these. */
  bestFiveCards: z.array(CardSchema).length(5),
  label: z.string().min(1).max(100),
});

const BlindLevelSchema = z.strictObject({
  smallBlind: PositiveSafeIntegerSchema,
  bigBlind: PositiveSafeIntegerSchema,
  hands: PositiveSafeIntegerSchema.optional(),
  durationSeconds: PositiveSafeIntegerSchema.optional(),
}).refine((value) => value.smallBlind < value.bigBlind, { message: "smallBlind must be below bigBlind" });

export const TournamentConfigSchema = z.strictObject({
  maxPlayers: z.number().int().min(2).max(10),
  startingStack: PositiveSafeIntegerSchema,
  smallBlind: PositiveSafeIntegerSchema,
  bigBlind: PositiveSafeIntegerSchema,
  blindMode: z.enum(["fixed", "time", "hands"]),
  blindStructure: z.array(BlindLevelSchema).min(1).max(100),
  actionTime: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.literal("UNLIMITED")]),
  timeBank: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120)]),
}).superRefine((value, context) => {
  if (value.smallBlind >= value.bigBlind) {
    context.addIssue({ code: "custom", message: "smallBlind must be below bigBlind" });
  }
  if (value.blindStructure[0]?.smallBlind !== value.smallBlind || value.blindStructure[0]?.bigBlind !== value.bigBlind) {
    context.addIssue({ code: "custom", message: "first blind level must match initial blinds" });
  }
  if (value.actionTime === "UNLIMITED" && value.timeBank !== 0) {
    context.addIssue({ code: "custom", message: "UNLIMITED actionTime requires zero timeBank" });
  }
  if (value.blindMode === "fixed" && value.blindStructure.length !== 1) {
    context.addIssue({ code: "custom", message: "fixed blindMode requires exactly one blind level" });
  }
  for (const level of value.blindStructure) {
    if (value.blindMode === "hands" && level.hands === undefined) {
      context.addIssue({ code: "custom", message: "hands blindMode requires hands for every level" });
    }
    if (value.blindMode === "time" && level.durationSeconds === undefined) {
      context.addIssue({ code: "custom", message: "time blindMode requires durationSeconds for every level" });
    }
  }
});

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type OpaqueId = z.infer<typeof OpaqueIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type DecimalSequence = z.infer<typeof DecimalSequenceSchema>;
export type Card = z.infer<typeof CardSchema>;
export type TournamentConfig = z.infer<typeof TournamentConfigSchema>;
export type LegalActions = z.infer<typeof LegalActionsSchema>;

export const LegalActionsSchema = z.strictObject({
  canFold: z.boolean(),
  canCheck: z.boolean(),
  canCall: z.boolean(),
  callAmount: SafeIntegerSchema,
  canBet: z.boolean(),
  minBetTo: SafeIntegerSchema.nullable(),
  canRaise: z.boolean(),
  minRaiseTo: SafeIntegerSchema.nullable(),
  maxRaiseTo: SafeIntegerSchema,
  canAllIn: z.boolean(),
  allInTo: SafeIntegerSchema,
});
