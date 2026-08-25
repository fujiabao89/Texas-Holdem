import type { FastifyInstance } from "fastify";
import {
  CLOSE_CODES,
  createProtocolError,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  validateClientCommand,
  type ClientCommand,
  type CommandResultPayload,
  type ErrorCode,
  type GameSnapshot,
  type ServerMessage,
} from "@texas-holdem/protocol";

import { hashPayload, type IdempotencyStore } from "../../http/middleware/idempotency";
import type { IdSource } from "../../rooms/id-source";
import { RoomDomainError } from "../../rooms/room-errors";
import type { RoomManager } from "../../rooms/room-manager";
import { projectPlayerView } from "../../projection/state-projector";
import type { TournamentManager } from "../../tournaments/tournament-manager";
import { createConnectionEpochRegistry, type ConnectionEpochRegistry } from "../connection-epochs";
import type { TournamentEventBus } from "../tournament-event-bus";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export interface LobbyGatewayClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LobbyGatewayOptions {
  readonly now: () => number;
  readonly ids: Pick<IdSource, "uuid">;
  readonly idempotency: IdempotencyStore;
  readonly clock?: LobbyGatewayClock;
  /** TEX-20 runtime is optional only for isolated TEX-24 Lobby tests. */
  readonly tournaments?: TournamentManager;
  readonly events?: TournamentEventBus;
  readonly epochs?: ConnectionEpochRegistry;
}

interface ActiveConnection {
  readonly connectionId: string;
  readonly roomId: string;
  readonly playerId: string;
  readonly epoch: number;
  replace(): void;
  sendServerMessage(message: ServerMessage): void;
}

type LobbyMutation = Extract<ClientCommand, { type: "SET_READY" | "LEAVE_ROOM" }>;

const systemClock: LobbyGatewayClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Minimal Lobby realtime gateway. It only relays server-authoritative RoomSnapshot
 * values; it never constructs room state from a client command or acknowledgement.
 */
export function registerLobbyGateway(app: FastifyInstance, manager: RoomManager, options: LobbyGatewayOptions): void {
  const activeConnections = new Map<string, ActiveConnection>();
  const authenticationAttempts = new Map<string, number>();
  const authenticatedPlayers = new Set<string>();
  let nextAuthenticationAttempt = 0;
  let nextIngressOrdinal = 0;
  const clock = options.clock ?? systemClock;
  const epochs = options.epochs ?? createConnectionEpochRegistry();

  options.events?.subscribe({
    onEvents(messages) {
      for (const message of messages) {
        const viewerPlayerId = message.payload.patch.viewer?.playerId;
        if (viewerPlayerId === undefined) continue;
        for (const connection of activeConnections.values()) {
          if (connection.playerId !== viewerPlayerId) continue;
          if (manager.getSnapshot(connection.roomId)?.activeTournamentId !== message.payload.tournamentId) continue;
          connection.sendServerMessage(message);
        }
      }
    },
    onClockUpdated(payload) {
      for (const connection of activeConnections.values()) {
        if (manager.getSnapshot(connection.roomId)?.activeTournamentId !== payload.tournamentId) continue;
        connection.sendServerMessage({
          type: "CLOCK_UPDATED",
          protocolVersion: PROTOCOL_VERSION,
          serverTime: options.now(),
          payload,
        });
      }
    },
  });

  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    let roomId: string | null = null;
    let playerId: string | null = null;
    let connectionId: string | null = null;
    let connectionKey: string | null = null;
    let connectionEpoch: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: unknown | null = null;
    let lastActivityAt = options.now();
    let membershipRevoked = false;
    let authenticated = false;

    const authTimer = clock.setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_CODES.AUTH_FAILED, "authenticate within five seconds");
    }, 5_000);

    const isCurrentConnection = (): boolean =>
      connectionKey !== null &&
      connectionId !== null &&
      connectionEpoch !== null &&
      activeConnections.get(connectionKey)?.connectionId === connectionId &&
      epochs.isCurrent(roomId as string, playerId as string, connectionEpoch);
    const send = (type: "ERROR" | "RECONNECT_RESULT" | "ROOM_SNAPSHOT" | "COMMAND_RESULT" | "SESSION_REPLACED", payload: unknown): void => {
      if (socket.readyState !== socket.OPEN) return;
      const message = ServerMessageSchema.parse({ type, protocolVersion: PROTOCOL_VERSION, serverTime: options.now(), payload });
      socket.send(JSON.stringify(message));
    };
    const sendServerMessage = (message: ServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(ServerMessageSchema.parse(message)));
    };
    const sendError = (code: ErrorCode): void => {
      send("ERROR", createProtocolError(code, options.ids.uuid(), { retryable: code === "GAME_UNAVAILABLE" || code === "RATE_LIMITED" }));
    };
    const clearSubscription = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };
    const clearHeartbeat = (): void => {
      if (heartbeat !== null) clock.clearInterval(heartbeat);
      heartbeat = null;
    };
    const replace = (): void => {
      clearSubscription();
      clearHeartbeat();
      send("SESSION_REPLACED", {});
      socket.close(CLOSE_CODES.SESSION_REPLACED, "replaced by a newer connection");
    };
    const gameSnapshot = (tournamentId: string, reason: GameSnapshot["reason"]): GameSnapshot | null => {
      const runtime = options.tournaments?.getView(tournamentId);
      if (runtime === undefined || playerId === null || runtime.roomId !== roomId) return null;
      const view = projectPlayerView({
        tournamentId,
        handId: runtime.currentHandId,
        sequence: runtime.lastWireSequence,
        engineState: runtime.engineState,
        seatToPlayer: runtime.seatToPlayer,
        actionDeadline: runtime.actionDeadline,
        currentLegalActions: runtime.currentLegalActions,
        timeBankRemainingMs: runtime.timeBankRemainingMs,
        viewerPlayerId: playerId,
      });
      return { snapshotVersion: 1, reason, tournamentId, sequence: String(runtime.lastWireSequence), ...view };
    };
    const sendGameSnapshot = (tournamentId: string, reason: GameSnapshot["reason"]): boolean => {
      const snapshot = gameSnapshot(tournamentId, reason);
      if (snapshot === null) return false;
      sendServerMessage({ type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: options.now(), payload: snapshot });
      return true;
    };
    const revokeMembership = (): void => {
      if (membershipRevoked) return;
      membershipRevoked = true;
      clearSubscription();
      // Allow a successful LEAVE_ROOM acknowledgement to be emitted before closing.
      queueMicrotask(() => socket.close(CLOSE_CODES.AUTH_FAILED, "room membership ended"));
    };
    const startHeartbeat = (): void => {
      lastActivityAt = options.now();
      heartbeat = clock.setInterval(() => {
        if (options.now() - lastActivityAt >= HEARTBEAT_TIMEOUT_MS) {
          socket.terminate();
          return;
        }
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);
    };

    socket.on("message", (raw: Buffer) => {
      void handleMessage(raw.toString());
    });
    socket.on("pong", () => {
      lastActivityAt = options.now();
    });
    socket.on("close", () => {
      clock.clearTimeout(authTimer);
      clearSubscription();
      clearHeartbeat();
      if (isCurrentConnection() && connectionKey !== null && roomId !== null && playerId !== null && connectionEpoch !== null) {
        activeConnections.delete(connectionKey);
        epochs.release(roomId, playerId, connectionEpoch);
        void manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "DISCONNECTED" }).catch(() => undefined);
        const activeTournamentId = manager.getSnapshot(roomId)?.activeTournamentId;
        if (activeTournamentId !== null && activeTournamentId !== undefined) {
          void options.tournaments?.setConnection(activeTournamentId, playerId, false).catch(() => undefined);
        }
      }
    });

    async function applyMutation(command: LobbyMutation): Promise<void> {
      const key = `player:${playerId as string}:ws:${command.requestId}`;
      const payloadHash = hashPayload({ type: command.type, payload: command.payload });
      try {
        const outcome = await options.idempotency.run(key, payloadHash, async () => {
          if (!isCurrentConnection()) throw new RoomDomainError("SESSION_REPLACED");
          if (command.type === "SET_READY") {
            await manager.submitCommand(roomId as string, { type: "SET_READY", playerId: playerId as string, ready: command.payload.ready });
          } else {
            const activeTournamentId = manager.getSnapshot(roomId as string)?.activeTournamentId;
            if (activeTournamentId !== null && activeTournamentId !== undefined && options.tournaments !== undefined) {
              await options.tournaments.submit(activeTournamentId, { type: "WITHDRAW_PLAYER", playerId: playerId as string, reason: "USER_LEFT" });
            } else {
              await manager.submitCommand(roomId as string, { type: "LEAVE", playerId: playerId as string, reason: "USER_LEFT", leftAt: options.now() });
            }
          }
          const body: CommandResultPayload = { requestId: command.requestId, status: "APPLIED", duplicate: false };
          return { statusCode: 200, body };
        });
        if (outcome.kind === "conflict") {
          send("COMMAND_RESULT", rejectedResult(command.requestId, "IDEMPOTENCY_KEY_REUSE", options.ids.uuid()));
          return;
        }
        const result = outcome.body as CommandResultPayload;
        send("COMMAND_RESULT", { ...result, duplicate: outcome.kind === "replay" });
      } catch (error) {
        send("COMMAND_RESULT", rejectedResult(command.requestId, error instanceof RoomDomainError ? error.code : "INTERNAL_ERROR", options.ids.uuid()));
      }
    }

    async function handleMessage(raw: string): Promise<void> {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        sendError("INVALID_MESSAGE");
        return;
      }
      const parsed = validateClientCommand(value);
      if (!parsed.success) {
        sendError(parsed.errorCode);
        if (parsed.errorCode === "UNSUPPORTED_PROTOCOL_VERSION") socket.close(CLOSE_CODES.PROTOCOL_ERROR);
        return;
      }
      const command = parsed.data;
      if (!authenticated) {
        if (command.type !== "AUTHENTICATE") {
          sendError("AUTH_REQUIRED");
          socket.close(CLOSE_CODES.AUTH_FAILED);
          return;
        }
        let pendingConnectionKey: string | null = null;
        let authenticationAttempt: number | null = null;
        try {
          roomId = command.payload.roomId;
          playerId = manager.authenticate(roomId, command.payload.playerToken);
          pendingConnectionKey = `${roomId}:${playerId}`;
          authenticationAttempt = ++nextAuthenticationAttempt;
          authenticationAttempts.set(pendingConnectionKey, authenticationAttempt);
          await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "CONNECTED" });
          const activeTournamentForConnection = manager.getSnapshot(roomId)?.activeTournamentId;
          if (activeTournamentForConnection !== null && activeTournamentForConnection !== undefined) {
            await options.tournaments?.setConnection(activeTournamentForConnection, playerId, true);
          }
          // The authentication timeout can close this socket while the room queue is busy.
          if (socket.readyState !== socket.OPEN) {
            if (authenticationAttempts.get(pendingConnectionKey) === authenticationAttempt && !activeConnections.has(pendingConnectionKey)) {
              await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "DISCONNECTED" });
            }
            if (authenticationAttempts.get(pendingConnectionKey) === authenticationAttempt) authenticationAttempts.delete(pendingConnectionKey);
            return;
          }
          const roomSnapshot = manager.getSnapshot(roomId);
          if (roomSnapshot === undefined) throw new RoomDomainError("ROOM_NOT_FOUND");

          connectionId = options.ids.uuid();
          connectionKey = pendingConnectionKey;
          connectionEpoch = epochs.takeOver(roomId, playerId);
          const previous = activeConnections.get(connectionKey);
          const resumed = authenticatedPlayers.has(connectionKey);
          authenticatedPlayers.add(connectionKey);
          activeConnections.set(connectionKey, {
            connectionId,
            roomId,
            playerId,
            epoch: connectionEpoch,
            replace,
            sendServerMessage,
          });
          if (authenticationAttempts.get(pendingConnectionKey) === authenticationAttempt) authenticationAttempts.delete(pendingConnectionKey);
          authenticated = true;
          clock.clearTimeout(authTimer);
          unsubscribe = manager.subscribe((snapshot) => {
            if (snapshot.roomId !== roomId || !isCurrentConnection()) return;
            if (!snapshot.players.some((player) => player.playerId === playerId)) {
              revokeMembership();
              return;
            }
            send("ROOM_SNAPSHOT", snapshot);
            if (snapshot.activeTournamentId !== null) {
              sendGameSnapshot(snapshot.activeTournamentId, "INITIAL");
            }
          });
          const activeTournamentId = roomSnapshot.activeTournamentId;
          send("RECONNECT_RESULT", {
            connectionId,
            resumed,
            tookOver: previous !== undefined,
            roomSnapshot,
            gameSnapshot: activeTournamentId === null || activeTournamentId === undefined ? null : gameSnapshot(activeTournamentId, resumed ? "RECONNECT" : "INITIAL"),
          });
          previous?.replace();
          startHeartbeat();
        } catch (error) {
          if (pendingConnectionKey !== null && authenticationAttempt !== null && authenticationAttempts.get(pendingConnectionKey) === authenticationAttempt) {
            authenticationAttempts.delete(pendingConnectionKey);
          }
          sendError(error instanceof RoomDomainError ? error.code : "AUTH_FAILED");
          socket.close(CLOSE_CODES.AUTH_FAILED);
        }
        return;
      }
      lastActivityAt = options.now();
      if (!isCurrentConnection()) {
        replace();
        return;
      }
      if (command.type === "AUTHENTICATE") {
        sendError("INVALID_MESSAGE");
        return;
      }
      switch (command.type) {
        case "SET_READY":
        case "LEAVE_ROOM":
          await applyMutation(command);
          return;
        case "SUBMIT_ACTION": {
          const currentRoom = manager.getSnapshot(roomId as string);
          if (currentRoom?.activeTournamentId !== command.payload.tournamentId || options.tournaments === undefined || connectionEpoch === null) {
            send("COMMAND_RESULT", rejectedResult(command.requestId, "TOURNAMENT_NOT_ACTIVE", options.ids.uuid(), command.payload.actionId));
            return;
          }
          try {
            const result = await options.tournaments.submit(command.payload.tournamentId, {
              type: "SUBMIT_ACTION",
              requestId: command.requestId,
              actionId: command.payload.actionId,
              playerId: playerId as string,
              expectedSequence: command.payload.expectedSequence,
              action: command.payload.action,
              receivedAt: options.now(),
              ingressOrdinal: ++nextIngressOrdinal,
              connectionEpoch,
            });
            if (result !== null) send("COMMAND_RESULT", result);
          } catch (error) {
            send("COMMAND_RESULT", rejectedResult(command.requestId, error instanceof RoomDomainError ? error.code : "INTERNAL_ERROR", options.ids.uuid(), command.payload.actionId));
          }
          return;
        }
        case "USE_TIME_BANK": {
          const currentRoom = manager.getSnapshot(roomId as string);
          if (currentRoom?.activeTournamentId !== command.payload.tournamentId || options.tournaments === undefined || connectionEpoch === null) {
            send("COMMAND_RESULT", rejectedResult(command.requestId, "TOURNAMENT_NOT_ACTIVE", options.ids.uuid()));
            return;
          }
          try {
            const result = await options.tournaments.submit(command.payload.tournamentId, {
              type: "USE_TIME_BANK",
              requestId: command.requestId,
              playerId: playerId as string,
              expectedSequence: command.payload.expectedSequence,
              receivedAt: options.now(),
              connectionEpoch,
            });
            if (result !== null) send("COMMAND_RESULT", result);
          } catch {
            send("COMMAND_RESULT", rejectedResult(command.requestId, "INTERNAL_ERROR", options.ids.uuid()));
          }
          return;
        }
        case "REQUEST_SNAPSHOT": {
          const snapshot = manager.getSnapshot(roomId as string);
          if (snapshot === undefined || !snapshot.players.some((player) => player.playerId === playerId)) {
            revokeMembership();
            return;
          }
          if (snapshot.activeTournamentId !== command.payload.tournamentId || !sendGameSnapshot(command.payload.tournamentId, "RESYNC")) {
            send("ERROR", createProtocolError("TOURNAMENT_NOT_ACTIVE", options.ids.uuid()));
          }
          return;
        }
        default:
          sendError("INVALID_MESSAGE");
      }
    }
  });
}

function rejectedResult(requestId: string, code: ErrorCode, traceId: string, actionId?: string): CommandResultPayload {
  return {
    requestId,
    actionId,
    status: "REJECTED",
    duplicate: false,
    error: createProtocolError(code, traceId, { retryable: code === "GAME_UNAVAILABLE" }),
  };
}
