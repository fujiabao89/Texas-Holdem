import { describe, expect, it } from "vitest";

import {
  applyPlayerViewPatch,
  createProtocolError,
  CreateRoomResponseSchema,
  LeaveRoomResponseSchema,
  StartTournamentResponseSchema,
  UpdateRoomResponseSchema,
  CommandResultPayloadSchema,
  DisplayNameSchema,
  GameEventSchema,
  GameEventMessageSchema,
  GameSnapshotSchema,
  JoinRoomRequestSchema,
  projectBotView,
  projectGameEventForViewer,
  projectPlayerView,
  ProtocolErrorSchema,
  PlayerViewSchema,
  RoomSnapshotSchema,
  ServerMessageSchema,
  TournamentConfigSchema,
  validateClientCommand,
  validateServerMessage,
} from "./index";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const actionId = "123e4567-e89b-42d3-a456-426614174001";
const aliceCard = { rank: "A", suit: "SPADES" } as const;
const bobCard = { rank: "K", suit: "HEARTS" } as const;
const tournamentConfig = {
  maxPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed" as const,
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30 as const, timeBank: 60 as const,
};
const roomSnapshot = {
  snapshotVersion: 1 as const, roomId: "room_1", roomRevision: "0", status: "LOBBY" as const, inviteCode: "ABC234", hostPlayerId: "alice",
  config: tournamentConfig, activeTournamentId: null, players: [],
};

const source = {
  handId: "hand_1",
  tournamentStatus: "RUNNING" as const,
  handPhase: "PREFLOP" as const,
  blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 },
  dealerSeat: 0,
  board: [],
  pots: [{ amount: 15, eligiblePlayerIds: ["alice", "bob"] }],
  currentActorPlayerId: "alice",
  actionDeadline: 1_700_000_000_000,
  players: [
    { playerId: "alice", displayName: "Alice", seat: 0, stack: 995, streetBet: 5, totalCommitted: 5, pokerStatus: "ACTIVE" as const, hasHoleCards: true, revealedCards: [], privateHoleCards: [aliceCard, aliceCard] },
    { playerId: "bob", displayName: "Bobby", seat: 1, stack: 990, streetBet: 10, totalCommitted: 10, pokerStatus: "ACTIVE" as const, hasHoleCards: true, revealedCards: [], privateHoleCards: [bobCard, bobCard] },
  ],
  viewer: { playerId: "alice", role: "PLAYER" as const, legalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 5, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 20, maxRaiseTo: 1000, canAllIn: true, allInTo: 1000 }, timeBankRemainingMs: 60_000 },
  rankings: [],
};

describe("protocol wire contracts", () => {
  it("rejects unsupported versions, unknown fields, and malformed command identifiers", () => {
    expect(validateClientCommand({ type: "AUTHENTICATE", protocolVersion: 2, requestId, payload: { roomId: "room_1", playerToken: "x" } })).toEqual({ success: false, errorCode: "UNSUPPORTED_PROTOCOL_VERSION" });
    expect(validateClientCommand({ type: "SET_READY", requestId, payload: { ready: true, actor: "alice" } })).toEqual({ success: false, errorCode: "INVALID_MESSAGE" });
    expect(validateClientCommand({ type: "SUBMIT_ACTION", requestId, payload: { tournamentId: "tournament_1", actionId, expectedSequence: 4, action: { type: "FOLD" } } })).toEqual({ success: false, errorCode: "INVALID_MESSAGE" });
    expect(validateClientCommand({ type: "SUBMIT_ACTION", requestId, payload: { tournamentId: "tournament_1", actionId, expectedSequence: "4", action: { type: "BET", betTo: 1.5 } } })).toEqual({ success: false, errorCode: "INVALID_MESSAGE" });
  });

  it("requires requestId for every WS command and actionId plus decimal expectedSequence for actions", () => {
    expect(validateClientCommand({ type: "USE_TIME_BANK", payload: { tournamentId: "tournament_1", expectedSequence: "4" } }).success).toBe(false);
    expect(validateClientCommand({ type: "SUBMIT_ACTION", requestId, payload: { tournamentId: "tournament_1", expectedSequence: "4", action: { type: "FOLD" } } }).success).toBe(false);
    expect(validateClientCommand({ type: "SUBMIT_ACTION", requestId, payload: { tournamentId: "tournament_1", actionId, expectedSequence: "9007199254740993", action: { type: "FOLD" } } }).success).toBe(true);
  });

  it("preserves uint64 sequences as strings and validates server protocol versions", () => {
    const snapshot = GameSnapshotSchema.parse({ snapshotVersion: 1, reason: "INITIAL", tournamentId: "tournament_1", sequence: "18446744073709551615", ...projectPlayerView(source) });
    expect(snapshot.sequence).toBe("18446744073709551615");
    expect(GameSnapshotSchema.safeParse({ ...snapshot, sequence: "18446744073709551616" }).success).toBe(false);
    expect(validateServerMessage({ type: "GAME_SNAPSHOT", protocolVersion: 2, serverTime: 1, payload: snapshot })).toEqual({ success: false, errorCode: "UNSUPPORTED_PROTOCOL_VERSION" });
  });

  it("creates stable safe error envelopes and rejects non-whitelisted details", () => {
    const error = createProtocolError("STALE_GAME_STATE", "trace_1", { details: { currentSequence: "9007199254740993" } });
    expect(error.message).toBe("stale game state");
    expect(ProtocolErrorSchema.safeParse({ ...error, details: { token: "secret" } }).success).toBe(false);
    expect(ProtocolErrorSchema.safeParse({ ...error, details: { currentSequence: 12 } }).success).toBe(false);
    expect(ProtocolErrorSchema.safeParse({ ...error, code: "STALE_ROOM_STATE", details: { currentRoomRevision: 12 } }).success).toBe(false);
    expect(ProtocolErrorSchema.safeParse({ ...error, code: "STALE_ROOM_STATE", details: { currentRoomRevision: "12" } }).success).toBe(true);
  });

  it("keeps HTTP success and credential responses strict", () => {
    expect(CreateRoomResponseSchema.safeParse({ data: { roomId: "room_1", playerId: "alice", playerToken: "x".repeat(43), roomSnapshot } }).success).toBe(true);
    expect(CreateRoomResponseSchema.safeParse({ data: { roomId: "room_1", playerId: "alice", playerToken: "x".repeat(43), roomSnapshot }, debug: true }).success).toBe(false);
    expect(UpdateRoomResponseSchema.safeParse({ data: { roomSnapshot } }).success).toBe(true);
    expect(StartTournamentResponseSchema.safeParse({ data: { tournamentId: "tournament_1", roomSnapshot } }).success).toBe(true);
    expect(LeaveRoomResponseSchema.safeParse({ data: { roomSnapshot, extra: true } }).success).toBe(false);
  });

  it("enforces frozen TournamentConfig cross-field constraints", () => {
    expect(TournamentConfigSchema.safeParse(tournamentConfig).success).toBe(true);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, smallBlind: 10, bigBlind: 10, blindStructure: [{ smallBlind: 10, bigBlind: 10 }] }).success).toBe(false);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, blindStructure: [{ smallBlind: 10, bigBlind: 20 }] }).success).toBe(false);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, actionTime: "UNLIMITED", timeBank: 60 }).success).toBe(false);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, blindStructure: [{ smallBlind: 5, bigBlind: 10 }, { smallBlind: 10, bigBlind: 20 }] }).success).toBe(false);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, blindMode: "hands", blindStructure: [{ smallBlind: 5, bigBlind: 10 }] }).success).toBe(false);
    expect(TournamentConfigSchema.safeParse({ ...tournamentConfig, blindMode: "time", blindStructure: [{ smallBlind: 5, bigBlind: 10 }] }).success).toBe(false);
  });

  it("enforces the display-name Unicode code-point boundary everywhere", () => {
    expect(DisplayNameSchema.safeParse("a".repeat(16)).success).toBe(true);
    expect(DisplayNameSchema.safeParse("a".repeat(17)).success).toBe(false);
    expect(DisplayNameSchema.safeParse("😀".repeat(16)).success).toBe(true);
    expect(DisplayNameSchema.safeParse("😀".repeat(17)).success).toBe(false);
    expect(DisplayNameSchema.safeParse("😀").success).toBe(false);
  });

  it("enforces invitation format, token entropy, and CLOSED room invitation removal", () => {
    expect(JoinRoomRequestSchema.safeParse({ inviteCode: "ABC234", displayName: "Alice" }).success).toBe(true);
    expect(JoinRoomRequestSchema.safeParse({ inviteCode: "ABCO01", displayName: "Alice" }).success).toBe(false);
    expect(validateClientCommand({ type: "AUTHENTICATE", protocolVersion: 1, requestId, payload: { roomId: "room_1", playerToken: "short" } }).success).toBe(false);
    expect(RoomSnapshotSchema.safeParse({ ...roomSnapshot, status: "CLOSED", inviteCode: "ABC234" }).success).toBe(false);
    expect(RoomSnapshotSchema.safeParse({ ...roomSnapshot, status: "CLOSED", inviteCode: null }).success).toBe(true);
  });

  it("keeps COMMAND_RESULT status and error fields consistent", () => {
    const error = createProtocolError("INVALID_ACTION", "trace_1");
    expect(CommandResultPayloadSchema.safeParse({ requestId, status: "APPLIED", duplicate: false, appliedSequence: "4" }).success).toBe(true);
    expect(CommandResultPayloadSchema.safeParse({ requestId, status: "APPLIED", duplicate: false, error }).success).toBe(false);
    expect(CommandResultPayloadSchema.safeParse({ requestId, status: "REJECTED", duplicate: false }).success).toBe(false);
    expect(CommandResultPayloadSchema.safeParse({ requestId, status: "REJECTED", duplicate: false, error }).success).toBe(true);
  });

  it("enforces POT_AWARDED chip conservation", () => {
    const payload = { type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 100, awards: [{ playerId: "alice", amount: 60 }, { playerId: "bob", amount: 40 }], winningHandRank: null } };
    expect(GameEventSchema.safeParse(payload).success).toBe(true);
    expect(GameEventSchema.safeParse({ ...payload, payload: { ...payload.payload, awards: [{ playerId: "alice", amount: 99 }] } }).success).toBe(false);
  });

  it("requires server-projected bestFiveCards for a public showdown reveal", () => {
    const payload = { type: "PLAYER_REVEALED", payload: { playerId: "alice", seat: 0, cards: [aliceCard, bobCard], handRank: { category: "STRAIGHT", tiebreakRanks: ["A"], label: "Straight", bestFiveCards: [aliceCard, bobCard, aliceCard, bobCard, aliceCard] } } };
    expect(GameEventSchema.safeParse(payload).success).toBe(true);
    const { bestFiveCards: _bestFiveCards, ...withoutBestFive } = payload.payload.handRank;
    expect(GameEventSchema.safeParse({ ...payload, payload: { ...payload.payload, handRank: withoutBestFive } }).success).toBe(false);
  });

  it("accepts withdrawal and tournament finish event catalog entries", () => {
    expect(GameEventSchema.safeParse({ type: "PLAYER_WITHDRAWN", payload: { playerId: "alice", seat: 0, forfeitedChips: 250 } }).success).toBe(true);
    expect(GameEventSchema.safeParse({ type: "TOURNAMENT_FINISHED", payload: { winnerPlayerId: "alice", rankings: [{ playerId: "alice", finishPosition: 1, tied: false }, { playerId: "bob", finishPosition: 2, tied: false }] } }).success).toBe(true);
    expect(GameEventSchema.safeParse({ type: "PLAYER_WITHDRAWN", payload: { playerId: "alice", seat: 0 } }).success).toBe(false);
  });

  it("projects PlayerView and BotView without other players' hole cards or server-only fields", () => {
    const aliceView = projectPlayerView(source);
    const spectatorView = projectPlayerView({ ...source, viewer: { ...source.viewer, playerId: "bob", role: "ELIMINATED_SPECTATOR" } });
    const botView = projectBotView({ ...source, viewer: { ...source.viewer, role: "BOT" } });
    const payload = JSON.stringify({ aliceView, spectatorView, botView });
    expect(aliceView.viewer.holeCards).toEqual([aliceCard, aliceCard]);
    expect(spectatorView.viewer.holeCards).toEqual([]);
    expect(spectatorView.viewer.legalActions).toBeNull();
    expect(botView.viewer.role).toBe("BOT");
    expect(payload).not.toContain(JSON.stringify(bobCard));
    expect(payload).not.toContain("privateHoleCards");
    expect(payload).not.toContain("playerToken");
    expect(payload).not.toContain("remainingDeck");
    expect(payload).not.toContain("burnCards");
    expect(() => projectPlayerView({ ...source, playerToken: "token-sentinel", remainingDeck: [bobCard], burnCards: [aliceCard] } as never)).toThrow();
    expect(projectPlayerView({ ...source, viewer: { ...source.viewer, playerId: "bob" } }).viewer.legalActions).toBeNull();
  });

  it("rejects legal actions for a non-actor and private spectator snapshots", () => {
    const validSnapshot = GameSnapshotSchema.parse({ snapshotVersion: 1, reason: "INITIAL", tournamentId: "tournament_1", sequence: "1", ...projectPlayerView(source) });
    expect(PlayerViewSchema.safeParse({ ...projectPlayerView(source), viewer: { ...projectPlayerView(source).viewer, playerId: "bob" } }).success).toBe(false);
    const privateSpectator = { ...validSnapshot, viewer: { ...validSnapshot.viewer, role: "ELIMINATED_SPECTATOR", holeCards: [aliceCard], legalActions: validSnapshot.viewer.legalActions } };
    expect(GameSnapshotSchema.safeParse(privateSpectator).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "GAME_SNAPSHOT", protocolVersion: 1, serverTime: 1, payload: privateSpectator }).success).toBe(false);
  });

  it("removes private deal card event payloads without changing event identity", () => {
    const event = GameEventMessageSchema.parse({
      type: "GAME_EVENT", protocolVersion: 1, serverTime: 1,
      payload: { tournamentId: "tournament_1", sequence: "9", handId: "hand_1", event: { type: "DEAL_HOLE_CARD", payload: { playerId: "alice", seat: 0, cardIndex: 0, card: aliceCard } }, patch: { viewer: { holeCards: [aliceCard] } } },
    });
    const bobEvent = projectGameEventForViewer(event, "bob");
    expect(bobEvent.payload.tournamentId).toBe(event.payload.tournamentId);
    expect(bobEvent.payload.sequence).toBe(event.payload.sequence);
    expect(bobEvent.payload.event).toEqual({ type: "DEAL_HOLE_CARD", payload: { playerId: "alice", seat: 0, cardIndex: 0 } });
    expect(bobEvent.payload.patch).toEqual({});
    expect(JSON.stringify(bobEvent)).not.toContain(JSON.stringify(aliceCard));
  });

  it("applies strict player patches equivalently and rejects unknown player updates", () => {
    const before = projectPlayerView(source);
    const after = applyPlayerViewPatch(before, { board: [aliceCard, bobCard, { rank: "2", suit: "CLUBS" }], currentActorPlayerId: "bob", players: [{ playerId: "alice", stack: 990, streetBet: 10 }], viewer: { legalActions: null } });
    expect(after.board).toHaveLength(3);
    expect(after.currentActorPlayerId).toBe("bob");
    expect(after.players.find((player) => player.playerId === "alice")?.stack).toBe(990);
    expect(() => applyPlayerViewPatch(before, { players: [{ playerId: "mallory", stack: 1 }] })).toThrow("unknown player");
    expect(ServerMessageSchema.safeParse({ type: "GAME_EVENT", protocolVersion: 1, serverTime: 1, payload: { tournamentId: "tournament_1", sequence: "1", handId: "hand_1", event: { type: "BURN_CARD", payload: { street: "FLOP", card: aliceCard } }, patch: {} } }).success).toBe(false);
  });
});
