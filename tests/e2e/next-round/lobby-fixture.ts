import type { Page, WebSocketRoute } from "@playwright/test";
import { PROTOCOL_VERSION, ServerMessageSchema, type RoomSnapshot, type ServerMessage } from "../../../packages/protocol/src";
import { roomSnapshot } from "../../../apps/web/src/testing-fixtures";
import { tableSnapshot } from "../animation-audio/table-fixture";

/** Stateful wire fixture only: browser stores are never accessed or mutated. */
export function nextRoundFixture() {
  let room: RoomSnapshot = roomSnapshot({ roomId: "room-49", status: "FINISHED", activeTournamentId: null, config: { ...roomSnapshot().config, maxPlayers: 4 } });
  const sockets = new Map<WebSocketRoute, string>();
  let game = false;
  let sequence = "1";
  let broadcastGame = true;
  const authentications: string[] = [];
  const requests: { method: string; body: Record<string, unknown>; key: string }[] = [];
  let fail: string | null = null;
  let pause: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const result = {
    tournamentId: "old-49", status: "FINISHED", championPlayerId: "player-1", finishedAt: 1000,
    players: room.players.map((p, i) => ({ playerId: p.playerId, displayName: p.displayName, seat: i, kind: "HUMAN", pokerStatus: i === 0 ? "ACTIVE" : "ELIMINATED", finalStack: i === 0 ? 2000 : 0 })),
    rankings: room.players.map((p, i) => ({ playerId: p.playerId, placement: { from: i + 1, to: i + 1 }, displayOrder: 1 })),
  };
  const send = (socket: WebSocketRoute, message: ServerMessage) => socket.send(JSON.stringify(ServerMessageSchema.parse(message)));
  const gameFor = (playerId: string) => tableSnapshot(room.players.length, {
    tournamentId: "new-49", handId: "new-hand-49", sequence,
    players: room.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, seat: p.seat!, stack: 1000, streetBet: 0, totalCommitted: 0, pokerStatus: "ACTIVE", hasHoleCards: false, revealedCards: [] })),
    currentActorPlayerId: null, pots: [],
    viewer: { playerId, role: "PLAYER", holeCards: [], legalActions: null, timeBankRemainingMs: 0 },
  });
  const broadcast = () => {
    for (const [socket, playerId] of sockets) {
      send(socket, { type: "ROOM_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: Date.now(), payload: room });
      if (game && broadcastGame) send(socket, { type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: Date.now(), payload: gameFor(playerId) });
    }
  };
  const change = (changes: Partial<RoomSnapshot>) => {
    room = { ...room, ...changes, roomRevision: String(BigInt(room.roomRevision) + 1n) };
    broadcast();
  };
  return {
    requests,
    authentications,
    onlyRoomOnStart() { broadcastGame = false; },
    newHandEvent() {
      sequence = String(BigInt(sequence) + 1n);
      for (const socket of sockets.keys()) send(socket, { type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: Date.now(), payload: { tournamentId: "new-49", handId: "new-hand-49", sequence, event: { type: "HAND_STARTED", payload: { handNumber: 1, dealerSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1, blindLevel: 0 } }, patch: {} } });
    },
    snapshot: () => room,
    change,
    failNext(code: string) { fail = code; },
    holdNext() { pause = new Promise<void>(resolve => { release = resolve; }); },
    release() { release?.(); pause = null; },
    async install(page: Page, playerId = "player-1", existing = true) {
      if (existing) await page.addInitScript((id) => {
        sessionStorage.setItem("texas-holdem:player-token:room-49", "x".repeat(43));
        sessionStorage.setItem("texas-holdem:player-id:room-49", id);
      }, playerId);
      await page.route("**/api/v1/tournaments/old-49/result", route => route.fulfill({ json: { data: result } }));
      await page.route("**/api/v1/tournaments/old-49/hands?*", route => route.fulfill({ json: { data: { tournamentId: "old-49", items: [], nextCursor: null } } }));
      await page.routeWebSocket("/api/v1/ws", socket => {
        sockets.set(socket, playerId);
        socket.onClose(() => { sockets.delete(socket); });
        socket.onMessage(raw => {
          const cmd = JSON.parse(raw.toString());
          if (cmd.type === "AUTHENTICATE") {
            authentications.push(playerId);
            send(socket, { type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: Date.now(), payload: { connectionId: "connection-49", resumed: true, tookOver: false, roomSnapshot: room, gameSnapshot: game ? gameFor(playerId) : null } });
          }
          if (cmd.type === "TIME_SYNC") { const time = Date.now(); send(socket, { type: "TIME_SYNC_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: time, payload: { requestId: cmd.requestId, clientSentAt: cmd.payload.clientSentAt, serverReceivedAt: time, serverSentAt: time } }); }
          if (cmd.type === "SET_READY") change({ players: room.players.map(p => p.playerId === playerId ? { ...p, ready: cmd.payload.ready } : p) });
        });
      });
      await page.route("**/api/v1/rooms/join", async route => {
        change({ players: [...room.players, { playerId, displayName: "新玩家", seat: null, ready: false, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" }] });
        await route.fulfill({ json: { data: { roomId: room.roomId, playerId, playerToken: "x".repeat(43), roomSnapshot: room } } });
      });
      await page.route(/\/api\/v1\/rooms\/room-49(?:\/tournaments)?$/, async route => {
        const req = route.request();
        const body = req.postDataJSON();
        requests.push({ method: req.method(), body, key: req.headers()["idempotency-key"] ?? "" });
        if (pause !== null) await pause;
        const code = fail ?? (body.expectedRoomRevision !== room.roomRevision ? "STALE_ROOM_STATE" : null);
        fail = null;
        if (code !== null) { await route.fulfill({ status: 409, json: { error: { code, message: "ignored", retryable: false, traceId: "49" } } }); return; }
        if (req.method() === "POST") { game = true; change({ status: "IN_GAME", activeTournamentId: "new-49", inviteCode: null }); }
        else if (body.operation.type === "REOPEN_LOBBY") change({ status: "LOBBY", inviteCode: "ABC234", players: room.players.map(p => ({ ...p, ready: false, pokerStatus: "ACTIVE" })) });
        else if (body.operation.type === "CHANGE_SEAT") change({ players: room.players.map(p => p.playerId === playerId ? { ...p, seat: body.operation.seat, ready: false } : p) });
        else if (body.operation.type === "KICK_PLAYER") change({ players: room.players.filter(p => p.playerId !== body.operation.targetPlayerId) });
        await route.fulfill({ json: { data: { roomSnapshot: room, ...(req.method() === "POST" ? { tournamentId: "new-49" } : {}) } } });
      });
    },
  };
}
