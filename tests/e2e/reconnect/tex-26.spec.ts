import { expect, test } from "../fixtures/observability";

const roomSnapshot = {
  snapshotVersion: 1, roomId: "room-1", roomRevision: "1", status: "IN_GAME", inviteCode: "ABC234", hostPlayerId: "player-1",
  config: { maxPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed", blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30, timeBank: 60 }, activeTournamentId: "tournament-1",
  players: [{ playerId: "player-1", displayName: "玩家甲", seat: 0, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" }, { playerId: "player-2", displayName: "玩家乙", seat: 1, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" }],
};
const gameSnapshot = {
  snapshotVersion: 1, reason: "INITIAL", tournamentId: "tournament-1", sequence: "1", handId: "hand-1", tournamentStatus: "RUNNING", handPhase: "PREFLOP", blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 }, dealerSeat: 0, board: [], pots: [{ amount: 15, eligiblePlayerIds: ["player-1", "player-2"] }], currentActorPlayerId: "player-1", actionDeadline: 50_000,
  players: [{ playerId: "player-1", displayName: "玩家甲", seat: 0, stack: 990, streetBet: 10, totalCommitted: 10, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] }, { playerId: "player-2", displayName: "玩家乙", seat: 1, stack: 995, streetBet: 5, totalCommitted: 5, pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [] }],
  viewer: { playerId: "player-1", role: "PLAYER", holeCards: [{ rank: "A", suit: "SPADES" }, { rank: "K", suit: "SPADES" }], legalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 5, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 20, maxRaiseTo: 990, canAllIn: true, allInTo: 1000 }, timeBankRemainingMs: 60_000 }, rankings: [],
};

test("TEX-26 Session Replaced 对话框可键盘访问", async ({ page }) => {
  await page.addInitScript('sessionStorage.setItem("texas-holdem:player-token:room-1", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");sessionStorage.setItem("texas-holdem:player-id:room-1", "player-1");');
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "AUTHENTICATE") {
        socket.send(JSON.stringify({ type: "RECONNECT_RESULT", protocolVersion: 1, serverTime: 1, payload: { connectionId: "connection-1", resumed: true, tookOver: false, roomSnapshot, gameSnapshot } }));
        socket.send(JSON.stringify({ type: "SESSION_REPLACED", protocolVersion: 1, serverTime: 2, payload: {} }));
      }
    });
  });
  await page.goto("/room/room-1/table");
  const dialog = page.getByRole("dialog", { name: "此牌局已在其他设备打开" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "在此设备重新接管" })).toBeVisible();
});
