import { z } from "zod";

import {
  CardSchema,
  DecimalSequenceSchema,
  DisplayNameSchema,
  EpochMillisecondsSchema,
  HandPhaseSchema,
  InviteCodeSchema,
  LegalActionsSchema,
  OpaqueIdSchema,
  PokerStatusSchema,
  SafeIntegerSchema,
  SeatSchema,
  TournamentConfigSchema,
  TournamentStatusSchema,
} from "./common";

const RoomPlayerSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  displayName: DisplayNameSchema,
  seat: SeatSchema.nullable(),
  ready: z.boolean(),
  connectionStatus: z.enum(["CONNECTED", "DISCONNECTED"]),
  pokerStatus: PokerStatusSchema,
});
export const RoomSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  roomId: OpaqueIdSchema,
  roomRevision: DecimalSequenceSchema,
  status: z.enum(["LOBBY", "IN_GAME", "FINISHED", "CLOSED"]),
  inviteCode: InviteCodeSchema.nullable(),
  hostPlayerId: OpaqueIdSchema.nullable(),
  config: TournamentConfigSchema,
  activeTournamentId: OpaqueIdSchema.nullable(),
  players: z.array(RoomPlayerSchema).max(10),
}).superRefine((value, context) => {
  if (value.status === "CLOSED" && value.inviteCode !== null) context.addIssue({ code: "custom", message: "closed rooms have no invite code" });
});

const PlayerPublicViewSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  displayName: DisplayNameSchema,
  seat: SeatSchema,
  stack: SafeIntegerSchema,
  streetBet: SafeIntegerSchema,
  totalCommitted: SafeIntegerSchema,
  pokerStatus: PokerStatusSchema,
  hasHoleCards: z.boolean(),
  revealedCards: z.array(CardSchema).max(2),
});
const RankingViewSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  placement: z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1) }).refine((value) => value.from <= value.to),
  displayOrder: z.number().int().min(1),
});
const BlindLevelViewSchema = z.strictObject({ index: z.number().int().min(0), smallBlind: SafeIntegerSchema, bigBlind: SafeIntegerSchema, ante: SafeIntegerSchema });
const PlayerViewerSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  role: z.enum(["PLAYER", "ELIMINATED_SPECTATOR"]),
  holeCards: z.array(CardSchema).max(2),
  legalActions: LegalActionsSchema.nullable(),
  timeBankRemainingMs: SafeIntegerSchema,
});
const BotViewerSchema = PlayerViewerSchema.extend({ role: z.literal("BOT") });

const PlayerViewShape = {
  handId: OpaqueIdSchema.nullable(),
  tournamentStatus: TournamentStatusSchema,
  handPhase: HandPhaseSchema.nullable(),
  blindLevel: BlindLevelViewSchema,
  dealerSeat: SeatSchema.nullable(),
  board: z.array(CardSchema).max(5),
  pots: z.array(z.strictObject({ amount: SafeIntegerSchema, eligiblePlayerIds: z.array(OpaqueIdSchema).min(1).max(10) })).max(10),
  currentActorPlayerId: OpaqueIdSchema.nullable(),
  actionDeadline: EpochMillisecondsSchema.nullable(),
  players: z.array(PlayerPublicViewSchema).max(10),
  viewer: PlayerViewerSchema,
  rankings: z.array(RankingViewSchema).max(10),
};

function validateViewerAuthorization(
  value: { readonly currentActorPlayerId: string | null; readonly viewer: { readonly playerId: string; readonly role: string; readonly holeCards: readonly unknown[]; readonly legalActions: unknown } },
  context: z.RefinementCtx,
): void {
  if (value.viewer.role === "ELIMINATED_SPECTATOR" && (value.viewer.holeCards.length !== 0 || value.viewer.legalActions !== null)) {
    context.addIssue({ code: "custom", message: "spectators cannot receive hole cards or legal actions" });
  }
  if (value.viewer.legalActions !== null && value.viewer.playerId !== value.currentActorPlayerId) {
    context.addIssue({ code: "custom", message: "only the current actor can receive legal actions" });
  }
}

export const PlayerViewSchema = z.strictObject(PlayerViewShape).superRefine(validateViewerAuthorization);

export const BotViewSchema = z.strictObject({ ...PlayerViewShape, viewer: BotViewerSchema }).superRefine(validateViewerAuthorization);
export const GameSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  reason: z.enum(["INITIAL", "RECONNECT", "RESYNC", "FAST_FORWARD", "STALE_ACTION"]),
  tournamentId: OpaqueIdSchema,
  sequence: DecimalSequenceSchema,
  ...PlayerViewShape,
}).superRefine(validateViewerAuthorization);

const PlayerPublicViewPatchSchema = PlayerPublicViewSchema.partial().extend({ playerId: OpaqueIdSchema });
export const PlayerViewPatchSchema = z.strictObject({
  handId: OpaqueIdSchema.nullable().optional(),
  tournamentStatus: TournamentStatusSchema.optional(),
  handPhase: HandPhaseSchema.nullable().optional(),
  blindLevel: BlindLevelViewSchema.optional(),
  dealerSeat: SeatSchema.nullable().optional(),
  board: z.array(CardSchema).max(5).optional(),
  pots: z.array(z.strictObject({ amount: SafeIntegerSchema, eligiblePlayerIds: z.array(OpaqueIdSchema).min(1).max(10) })).max(10).optional(),
  currentActorPlayerId: OpaqueIdSchema.nullable().optional(),
  actionDeadline: EpochMillisecondsSchema.nullable().optional(),
  players: z.array(PlayerPublicViewPatchSchema).max(10).optional(),
  viewer: PlayerViewerSchema.partial().optional(),
  rankings: z.array(RankingViewSchema).max(10).optional(),
});

export const ReconnectResultSchema = z.strictObject({
  connectionId: OpaqueIdSchema,
  resumed: z.boolean(),
  tookOver: z.boolean(),
  roomSnapshot: RoomSnapshotSchema,
  gameSnapshot: GameSnapshotSchema.nullable(),
});

export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;
export type PlayerView = z.infer<typeof PlayerViewSchema>;
export type BotView = z.infer<typeof BotViewSchema>;
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;
export type PlayerViewPatch = z.infer<typeof PlayerViewPatchSchema>;
export type ReconnectResult = z.infer<typeof ReconnectResultSchema>;
