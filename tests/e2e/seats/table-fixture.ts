import type { Page } from "@playwright/test";

import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type GameEvent,
  type GameSnapshot,
  type PlayerViewPatch,
  type RoomSnapshot,
  type ServerMessage,
} from "../../../packages/protocol/src";
import { expect } from "../fixtures/observability";

export type SeatSnapshotOptions = {
  readonly playerCount: number;
  readonly viewerSeat?: number;
  readonly dealerSeat?: number;
  readonly smallBlindSeat?: number;
  readonly bigBlindSeat?: number;
  readonly currentActorSeat?: number;
  readonly configure?: (players: ReadonlyArray<GameSnapshot["players"][number]>) => ReadonlyArray<GameSnapshot["players"][number]>;
};

/** Wire-only fixture (TEX-47): builds authoritative seat/blind projections without a real server. */
export function seatTableSnapshot(options: SeatSnapshotOptions): GameSnapshot {
  const players = Array.from({ length: options.playerCount }, (_, seat) => ({
    playerId: `player-${seat + 1}`,
    displayName: `玩家${seat + 1}`,
    seat,
    stack: 990,
    streetBet: 0,
    totalCommitted: 0,
    pokerStatus: "ACTIVE" as const,
    hasHoleCards: true,
    revealedCards: [],
  }));
  return {
    snapshotVersion: 1,
    reason: "INITIAL",
    tournamentId: "tournament-seats",
    sequence: "1",
    handId: "hand-seats",
    tournamentStatus: "RUNNING",
    handPhase: "PREFLOP",
    blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 },
    dealerSeat: options.dealerSeat ?? 0,
    smallBlindSeat: options.smallBlindSeat ?? 0,
    bigBlindSeat: options.bigBlindSeat ?? 1,
    board: [],
    pots: [{ amount: 15, eligiblePlayerIds: players.map((player) => player.playerId) }],
    currentActorPlayerId: `player-${(options.currentActorSeat ?? options.viewerSeat ?? 0) + 1}`,
    actionDeadline: null,
    players: options.configure === undefined ? players : [...options.configure(players)],
    viewer: {
      playerId: `player-${(options.viewerSeat ?? 0) + 1}`,
      role: "PLAYER",
      holeCards: [],
      legalActions: null,
      timeBankRemainingMs: 0,
    },
    rankings: [],
  };
}

export async function installSeatTable(page: Page, initialGame: GameSnapshot) {
  const room: RoomSnapshot = {
    snapshotVersion: 1,
    roomId: "room-seats",
    roomRevision: "1",
    status: "IN_GAME",
    inviteCode: "ABC234",
    hostPlayerId: initialGame.players[0]?.playerId ?? null,
    config: {
      maxPlayers: initialGame.players.length,
      startingStack: 1_000,
      smallBlind: 5,
      bigBlind: 10,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
      actionTime: "UNLIMITED",
      timeBank: 0,
    },
    activeTournamentId: initialGame.tournamentId,
    players: initialGame.players.map(({ playerId, displayName, seat }) => ({ playerId, displayName, seat, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" })),
  };
  await page.addInitScript((viewerId) => {
    sessionStorage.setItem("texas-holdem:player-token:room-seats", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    sessionStorage.setItem("texas-holdem:player-id:room-seats", viewerId);
  }, initialGame.viewer.playerId);
  let latest = initialGame;
  let sendMessage: ((message: ServerMessage) => void) | undefined;
  const commands: Array<{ type: string }> = [];
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    sendMessage = (message) => socket.send(JSON.stringify(ServerMessageSchema.parse(message)));
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string };
      commands.push(command);
      if (command.type === "AUTHENTICATE") {
        sendMessage!({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 0, payload: {
          connectionId: "connection-seats", resumed: true, tookOver: false, roomSnapshot: room, gameSnapshot: latest,
        } });
      }
      if (command.type === "REQUEST_SNAPSHOT") {
        sendMessage!({ type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: Number(latest.sequence), payload: { ...latest, reason: "RESYNC" } });
      }
    });
  });
  return {
    commands,
    async open() {
      await page.goto("/room/room-seats/table");
      // Next dev cold-compiles this route under parallel workers; wait for the
      // projection-driven seats instead of asserting within the default 5s.
      await expect(page.locator("[data-seat]")).toHaveCount(initialGame.players.length, { timeout: 15_000 });
    },
    event(event: GameEvent, patch: PlayerViewPatch = {}) {
      if (sendMessage === undefined) throw new Error("Open the table before sending events");
      const sequence = String(BigInt(latest.sequence) + 1n);
      const players = latest.players.map((player) => ({ ...player, ...patch.players?.find((next) => next.playerId === player.playerId) }));
      latest = { ...latest, ...patch, sequence, players, viewer: { ...latest.viewer, ...patch.viewer } };
      sendMessage({ type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: Number(sequence), payload: {
        tournamentId: latest.tournamentId, handId: latest.handId, sequence, event, patch,
      } });
    },
  };
}

/** Reads the rendered seatIndex → visual slot mapping without depending on CSS classes. */
export async function seatSlots(page: Page): Promise<Record<string, string | null>> {
  return page.locator("[data-seat]").evaluateAll((seats) => Object.fromEntries(seats.map((seat) => [seat.getAttribute("data-seat") ?? "?", seat.getAttribute("data-seat-slot")])));
}
