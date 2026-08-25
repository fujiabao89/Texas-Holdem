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
import { TournamentDomainError } from "../../tournaments/tournament-errors";
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
  isOpen(): boolean;
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
  const authenticatedPlayers = new Map<string, Set<string>>();
  let nextAuthenticationAttempt = 0;
  let nextIngressOrdinal = 0;
  const clock = options.clock ?? systemClock;
  const epochs = options.epochs ?? createConnectionEpochRegistry();

  // `resumed` is Room-lifetime history, not active-socket history. Prune it only
  // when authoritative Room membership ends (or the Room closes).
  manager.subscribe((snapshot) => {
    const history = authenticatedPlayers.get(snapshot.roomId);
    if (history === undefined) return;
    if (snapshot.status === "CLOSED") {
      authenticatedPlayers.delete(snapshot.roomId);
      return;
    }
    const members = new Set(snapshot.players.map((player) => player.playerId));
    for (const playerId of history) {
      if (!members.has(playerId)) history.delete(playerId);
    }
    if (history.size === 0) authenticatedPlayers.delete(snapshot.roomId);
  });

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
        const viewerTimeBank = options.tournaments?.getView(payload.tournamentId)?.timeBankRemainingMs.get(connection.playerId) ?? 0;
        connection.sendServerMessage({
          type: "CLOCK_UPDATED",
          protocolVersion: PROTOCOL_VERSION,
          serverTime: options.now(),
          payload: { ...payload, timeBankRemainingMs: viewerTimeBank },
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
    let previousConnection: ActiveConnection | undefined;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: unknown | null = null;
    let lastActivityAt = options.now();
    let membershipRevoked = false;
    let authenticated = false;

    const authTimer = clock.setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_CODES.AUTH_FAILED, "authenticate within five seconds");
    }, 5_000);

    const currentConnection = (): ActiveConnection | undefined =>
      connectionKey === null || connectionId === null
        ? undefined
        : activeConnections.get(connectionKey)?.connectionId === connectionId
          ? activeConnections.get(connectionKey)
          : undefined;
    const isCurrentConnection = (): boolean => {
      const current = currentConnection();
      return current !== undefined && roomId !== null && playerId !== null && epochs.isCurrent(roomId, playerId, current.epoch);
    };
    const send = (type: "ERROR" | "RECONNECT_RESULT" | "ROOM_SNAPSHOT" | "COMMAND_RESULT" | "SESSION_REPLACED", payload: unknown): void => {
      if (socket.readyState !== socket.OPEN) return;
      const message = ServerMessageSchema.parse({ type, protocolVersion: PROTOCOL_VERSION, serverTime: options.now(), payload });
      socket.send(JSON.stringify(message));
    };
    const sendServerMessage = (message: ServerMessage): void => {
      // Ownership is reserved before async authentication side effects finish;
      // retain the reconnect snapshot as the first realtime state barrier.
      if (!authenticated || socket.readyState !== socket.OPEN) return;
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
    const rollbackReservation = (): void => {
      if (previousConnection === undefined || connectionKey === null || connectionId === null || roomId === null || playerId === null) return;
      const current = activeConnections.get(connectionKey);
      // A later authentication has already claimed this player; never restore a
      // superseded socket over it.
      if (current !== undefined && current.connectionId !== connectionId) return;
      // The replaced socket can also have closed while the reservation was
      // pending. It is not a connection to restore after auth rollback.
      if (!previousConnection.isOpen()) return;

      const restoredEpoch = epochs.takeOver(roomId, playerId);
      activeConnections.set(connectionKey, { ...previousConnection, epoch: restoredEpoch });
      void manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "CONNECTED" }).catch(() => undefined);
      const activeTournamentId = manager.getSnapshot(roomId)?.activeTournamentId;
      if (activeTournamentId !== null && activeTournamentId !== undefined) {
        void options.tournaments?.setConnection(activeTournamentId, playerId, true).catch(() => undefined);
      }
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
      const current = currentConnection();
      if (isCurrentConnection() && current !== undefined && connectionKey !== null && roomId !== null && playerId !== null) {
        activeConnections.delete(connectionKey);
        epochs.release(roomId, playerId, current.epoch);
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
          const epoch = currentConnection()?.epoch;
          if (epoch === undefined) throw new RoomDomainError("SESSION_REPLACED");
          if (command.type === "SET_READY") {
            await manager.submitCommand(roomId as string, { type: "SET_READY", playerId: playerId as string, ready: command.payload.ready, connectionEpoch: epoch });
          } else {
            const activeTournamentId = manager.getSnapshot(roomId as string)?.activeTournamentId;
            if (activeTournamentId !== null && activeTournamentId !== undefined && options.tournaments !== undefined) {
              await options.tournaments.submit(activeTournamentId, { type: "WITHDRAW_PLAYER", playerId: playerId as string, reason: "USER_LEFT", connectionEpoch: epoch });
              await manager.submitCommand(roomId as string, {
                type: "LEAVE",
                playerId: playerId as string,
                reason: "USER_LEFT",
                leftAt: options.now(),
                afterTournamentWithdrawal: true,
                connectionEpoch: epoch,
              });
            } else {
              await manager.submitCommand(roomId as string, { type: "LEAVE", playerId: playerId as string, reason: "USER_LEFT", leftAt: options.now(), connectionEpoch: epoch });
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
        send("COMMAND_RESULT", rejectedResult(command.requestId, domainErrorCode(error), options.ids.uuid()));
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
          // Reserve ownership before either awaited authority update. If the old
          // socket closes during this window, its close handler is already stale
          // and cannot queue DISCONNECTED behind this connection's CONNECTED.
          connectionId = options.ids.uuid();
          connectionKey = pendingConnectionKey;
          connectionEpoch = epochs.takeOver(roomId, playerId);
          previousConnection = activeConnections.get(connectionKey);
          activeConnections.set(connectionKey, {
            connectionId,
            roomId,
            playerId,
            epoch: connectionEpoch,
            isOpen: () => socket.readyState === socket.OPEN,
            replace,
            sendServerMessage,
          });

          await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "CONNECTED" });
          const activeTournamentForConnection = manager.getSnapshot(roomId)?.activeTournamentId;
          if (activeTournamentForConnection !== null && activeTournamentForConnection !== undefined) {
            await options.tournaments?.setConnection(activeTournamentForConnection, playerId, true);
          }
          // The authentication timeout can close this socket while the room queue is busy.
          // Its close handler releases the reservation and reports DISCONNECTED.
          if (socket.readyState !== socket.OPEN || !isCurrentConnection()) {
            rollbackReservation();
            if (authenticationAttempts.get(pendingConnectionKey) === authenticationAttempt) authenticationAttempts.delete(pendingConnectionKey);
            return;
          }
          const roomSnapshot = manager.getSnapshot(roomId);
          if (roomSnapshot === undefined) throw new RoomDomainError("ROOM_NOT_FOUND");

          const authenticatedInRoom = authenticatedPlayers.get(roomId) ?? new Set<string>();
          const resumed = authenticatedInRoom.has(playerId);
          authenticatedInRoom.add(playerId);
          authenticatedPlayers.set(roomId, authenticatedInRoom);
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
          });
          const activeTournamentId = roomSnapshot.activeTournamentId;
          send("RECONNECT_RESULT", {
            connectionId,
            resumed,
            tookOver: previousConnection !== undefined,
            roomSnapshot,
            gameSnapshot: activeTournamentId === null || activeTournamentId === undefined ? null : gameSnapshot(activeTournamentId, resumed ? "RECONNECT" : "INITIAL"),
          });
          previousConnection?.replace();
          startHeartbeat();
        } catch (error) {
          rollbackReservation();
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
          const epoch = currentConnection()?.epoch;
          if (currentRoom?.activeTournamentId !== command.payload.tournamentId || options.tournaments === undefined || epoch === undefined) {
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
              connectionEpoch: epoch,
            });
            if (result !== null) send("COMMAND_RESULT", result);
          } catch (error) {
            send("COMMAND_RESULT", rejectedResult(command.requestId, domainErrorCode(error), options.ids.uuid(), command.payload.actionId));
          }
          return;
        }
        case "USE_TIME_BANK": {
          const currentRoom = manager.getSnapshot(roomId as string);
          const epoch = currentConnection()?.epoch;
          if (currentRoom?.activeTournamentId !== command.payload.tournamentId || options.tournaments === undefined || epoch === undefined) {
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
              connectionEpoch: epoch,
            });
            if (result !== null) send("COMMAND_RESULT", result);
          } catch (error) {
            send("COMMAND_RESULT", rejectedResult(command.requestId, domainErrorCode(error), options.ids.uuid()));
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

function domainErrorCode(error: unknown): ErrorCode {
  return error instanceof RoomDomainError || error instanceof TournamentDomainError
    ? error.code
    : "INTERNAL_ERROR";
}
