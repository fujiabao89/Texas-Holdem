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
export const RankingViewSchema = z.strictObject({
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
  smallBlindSeat: SeatSchema.nullable(),
  bigBlindSeat: SeatSchema.nullable(),
  board: z.array(CardSchema).max(5),
  pots: z.array(z.strictObject({ amount: SafeIntegerSchema, eligiblePlayerIds: z.array(OpaqueIdSchema).min(1).max(10) })).max(10),
  currentActorPlayerId: OpaqueIdSchema.nullable(),
  actionDeadline: EpochMillisecondsSchema.nullable(),
  /**
   * Server-authoritative epoch-ms timestamp until which clients SHOULD display showdown
   * results and animations (e.g. card reveals, pot-award highlights, hand-rank labels).
   * Non-null only when handPhase === "SHOWDOWN_DISPLAY". The server sets this to
   * serverTime + showdown display duration and transitions handPhase to "HAND_END" (or
   * the next hand) after the window closes. Clients MUST NOT use this field to decide
   * action legality or game state transitions — it is purely a display hint.
   * currentActorPlayerId and actionDeadline are always null when this is non-null.
   */
  showdownDisplayUntil: EpochMillisecondsSchema.nullable(),
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

/**
 * Cross-field invariants for the SHOWDOWN_DISPLAY phase and the action clock.
 *
 * - showdownDisplayUntil must be non-null iff handPhase === "SHOWDOWN_DISPLAY".
 * - During SHOWDOWN_DISPLAY: currentActorPlayerId and actionDeadline must both be null
 *   (no action is expected; the clock is paused).
 * - Outside SHOWDOWN_DISPLAY: showdownDisplayUntil must be null.
 */
function validateShowdownAndClockInvariants(
  value: {
    readonly handPhase: string | null;
    readonly showdownDisplayUntil: number | null;
    readonly currentActorPlayerId: string | null;
    readonly actionDeadline: number | null;
  },
  context: z.RefinementCtx,
): void {
  const isShowdownDisplay = value.handPhase === "SHOWDOWN_DISPLAY";
  if (isShowdownDisplay && value.showdownDisplayUntil === null) {
    context.addIssue({ code: "custom", message: "showdownDisplayUntil must be non-null during SHOWDOWN_DISPLAY" });
  }
  if (!isShowdownDisplay && value.showdownDisplayUntil !== null) {
    context.addIssue({ code: "custom", message: "showdownDisplayUntil must be null outside SHOWDOWN_DISPLAY" });
  }
  if (isShowdownDisplay && value.currentActorPlayerId !== null) {
    context.addIssue({ code: "custom", message: "currentActorPlayerId must be null during SHOWDOWN_DISPLAY" });
  }
  if (isShowdownDisplay && value.actionDeadline !== null) {
    context.addIssue({ code: "custom", message: "actionDeadline must be null during SHOWDOWN_DISPLAY" });
  }
}

export const PlayerViewSchema = z.strictObject(PlayerViewShape)
  .superRefine(validateViewerAuthorization)
  .superRefine(validateShowdownAndClockInvariants);

export const BotViewSchema = z.strictObject({ ...PlayerViewShape, viewer: BotViewerSchema })
  .superRefine(validateViewerAuthorization)
  .superRefine(validateShowdownAndClockInvariants);
export const GameSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  reason: z.enum(["INITIAL", "RECONNECT", "RESYNC", "FAST_FORWARD", "STALE_ACTION"]),
  tournamentId: OpaqueIdSchema,
  sequence: DecimalSequenceSchema,
  ...PlayerViewShape,
}).superRefine(validateViewerAuthorization).superRefine(validateShowdownAndClockInvariants);

const PlayerPublicViewPatchSchema = PlayerPublicViewSchema.partial().extend({ playerId: OpaqueIdSchema });
export const PlayerViewPatchSchema = z.strictObject({
  handId: OpaqueIdSchema.nullable().optional(),
  tournamentStatus: TournamentStatusSchema.optional(),
  handPhase: HandPhaseSchema.nullable().optional(),
  blindLevel: BlindLevelViewSchema.optional(),
  dealerSeat: SeatSchema.nullable().optional(),
  smallBlindSeat: SeatSchema.nullable().optional(),
  bigBlindSeat: SeatSchema.nullable().optional(),
  board: z.array(CardSchema).max(5).optional(),
  pots: z.array(z.strictObject({ amount: SafeIntegerSchema, eligiblePlayerIds: z.array(OpaqueIdSchema).min(1).max(10) })).max(10).optional(),
  currentActorPlayerId: OpaqueIdSchema.nullable().optional(),
  actionDeadline: EpochMillisecondsSchema.nullable().optional(),
  /** See PlayerViewShape.showdownDisplayUntil — partial update; null clears the window. */
  showdownDisplayUntil: EpochMillisecondsSchema.nullable().optional(),
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
