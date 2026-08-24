import type { GameSnapshot, RoomSnapshot } from "@texas-holdem/protocol";

export const testConfig = {
  maxPlayers: 2,
  startingStack: 1_000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed" as const,
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30 as const,
  timeBank: 60 as const,
};

export function roomSnapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    snapshotVersion: 1,
    roomId: "room-1",
    roomRevision: "1",
    status: "IN_GAME",
    inviteCode: "ABC234",
    hostPlayerId: "player-1",
    config: testConfig,
    activeTournamentId: "tournament-1",
    players: [
      { playerId: "player-1", displayName: "玩家甲", seat: 0, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
      { playerId: "player-2", displayName: "玩家乙", seat: 1, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
    ],
    ...overrides,
  };
}

export function gameSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    snapshotVersion: 1,
    reason: "INITIAL",
    tournamentId: "tournament-1",
    sequence: "9007199254740991",
    handId: "hand-1",
    tournamentStatus: "RUNNING",
    handPhase: "PREFLOP",
    blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 },
    dealerSeat: 0,
    board: [],
    pots: [{ amount: 15, eligiblePlayerIds: ["player-1", "player-2"] }],
    currentActorPlayerId: "player-1",
    actionDeadline: 10_000,
    players: [
      { playerId: "player-1", displayName: "玩家甲", seat: 0, stack: 990, streetBet: 10, totalCommitted: 10, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] },
      { playerId: "player-2", displayName: "玩家乙", seat: 1, stack: 995, streetBet: 5, totalCommitted: 5, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] },
    ],
    viewer: {
      playerId: "player-1",
      role: "PLAYER",
      holeCards: [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "SPADES" }],
      legalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 5, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 20, maxRaiseTo: 990, canAllIn: true, allInTo: 1_000 },
      timeBankRemainingMs: 60_000,
    },
    rankings: [],
    ...overrides,
  };
}
