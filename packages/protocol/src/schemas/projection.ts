import { z } from "zod";

import { GameEventMessageSchema } from "../events";
import { CardSchema, DisplayNameSchema, LegalActionsSchema, OpaqueIdSchema, SafeIntegerSchema } from "./common";
import { BotViewSchema, PlayerViewPatchSchema, PlayerViewSchema } from "./views";

/**
 * Deliberately narrow server-only input contract. It excludes deck order, burn cards,
 * tokens, persistence data and arbitrary server state, so projection cannot accidentally
 * spread such data into a client payload.
 */
const ProjectablePlayerSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  displayName: DisplayNameSchema,
  seat: z.number().int().min(0).max(9),
  stack: SafeIntegerSchema,
  streetBet: SafeIntegerSchema,
  totalCommitted: SafeIntegerSchema,
  pokerStatus: z.enum(["ACTIVE", "EXIT_PENDING", "WITHDRAWN", "ELIMINATED"]),
  hasHoleCards: z.boolean(),
  revealedCards: z.array(CardSchema).max(2),
  privateHoleCards: z.array(CardSchema).max(2),
});
const ProjectableViewerSchema = z.strictObject({
  playerId: OpaqueIdSchema,
  role: z.enum(["PLAYER", "ELIMINATED_SPECTATOR", "BOT"]),
  legalActions: LegalActionsSchema.nullable(),
  timeBankRemainingMs: SafeIntegerSchema,
});
export const ProjectableGameSourceSchema = z.strictObject({
  handId: OpaqueIdSchema.nullable(),
  tournamentStatus: z.enum(["RUNNING", "FINISHED"]),
  handPhase: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER", "HAND_END"]).nullable(),
  blindLevel: z.strictObject({ index: z.number().int().min(0), smallBlind: SafeIntegerSchema, bigBlind: SafeIntegerSchema, ante: SafeIntegerSchema }),
  dealerSeat: z.number().int().min(0).max(9).nullable(),
  board: z.array(CardSchema).max(5),
  pots: z.array(z.strictObject({ amount: SafeIntegerSchema, eligiblePlayerIds: z.array(OpaqueIdSchema).min(1).max(10) })).max(10),
  currentActorPlayerId: OpaqueIdSchema.nullable(),
  actionDeadline: SafeIntegerSchema.nullable(),
  players: z.array(ProjectablePlayerSchema).max(10),
  viewer: ProjectableViewerSchema,
  rankings: z.array(z.strictObject({ playerId: OpaqueIdSchema, placement: z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1) }), displayOrder: z.number().int().min(1) })).max(10),
});

export function projectPlayerView(sourceInput: z.infer<typeof ProjectableGameSourceSchema>): z.infer<typeof PlayerViewSchema> {
  const source = ProjectableGameSourceSchema.parse(sourceInput);
  const owner = source.players.find((player) => player.playerId === source.viewer.playerId);
  const isSpectator = source.viewer.role === "ELIMINATED_SPECTATOR";
  if (!owner) throw new Error("projection source viewer must be a tournament player");
  return PlayerViewSchema.parse({
    handId: source.handId,
    tournamentStatus: source.tournamentStatus,
    handPhase: source.handPhase,
    blindLevel: source.blindLevel,
    dealerSeat: source.dealerSeat,
    board: source.board,
    pots: source.pots,
    currentActorPlayerId: source.currentActorPlayerId,
    actionDeadline: source.actionDeadline,
    players: source.players.map(({ privateHoleCards: _privateHoleCards, ...player }) => player),
    viewer: {
      playerId: source.viewer.playerId,
      role: isSpectator ? "ELIMINATED_SPECTATOR" : "PLAYER",
      holeCards: isSpectator ? [] : owner.privateHoleCards,
      legalActions: isSpectator || source.currentActorPlayerId !== source.viewer.playerId ? null : source.viewer.legalActions,
      timeBankRemainingMs: source.viewer.timeBankRemainingMs,
    },
    rankings: source.rankings,
  });
}

export function projectBotView(sourceInput: z.infer<typeof ProjectableGameSourceSchema>): z.infer<typeof BotViewSchema> {
  const source = ProjectableGameSourceSchema.parse(sourceInput);
  if (source.viewer.role !== "BOT") throw new Error("bot projection requires BOT viewer role");
  const playerView = projectPlayerView(source);
  return BotViewSchema.parse({ ...playerView, viewer: { ...playerView.viewer, role: "BOT" } });
}

export function projectGameEventForViewer(
  messageInput: z.infer<typeof GameEventMessageSchema>,
  viewerPlayerId: z.infer<typeof OpaqueIdSchema>,
): z.infer<typeof GameEventMessageSchema> {
  const message = GameEventMessageSchema.parse(messageInput);
  const viewer = OpaqueIdSchema.parse(viewerPlayerId);
  if (message.payload.event.type !== "DEAL_HOLE_CARD" || message.payload.event.payload.playerId === viewer) return message;
  const { card: _card, ...publicPayload } = message.payload.event.payload;
  const { viewer: _viewer, ...publicPatch } = message.payload.patch;
  return GameEventMessageSchema.parse({
    ...message,
    payload: { ...message.payload, event: { type: "DEAL_HOLE_CARD", payload: publicPayload }, patch: publicPatch },
  });
}

export function applyPlayerViewPatch(
  previousInput: z.infer<typeof PlayerViewSchema>,
  patchInput: z.infer<typeof PlayerViewPatchSchema>,
): z.infer<typeof PlayerViewSchema> {
  const previous = PlayerViewSchema.parse(previousInput);
  const patch = PlayerViewPatchSchema.parse(patchInput);
  const players = patch.players === undefined
    ? previous.players
    : previous.players.map((player) => {
        const update = patch.players?.find((candidate) => candidate.playerId === player.playerId);
        return update === undefined ? player : { ...player, ...update };
      });
  if (patch.players?.some((update) => !previous.players.some((player) => player.playerId === update.playerId))) {
    throw new Error("player patch cannot create an unknown player");
  }
  return PlayerViewSchema.parse({ ...previous, ...patch, players, viewer: patch.viewer === undefined ? previous.viewer : { ...previous.viewer, ...patch.viewer } });
}

export type ProjectableGameSource = z.infer<typeof ProjectableGameSourceSchema>;
