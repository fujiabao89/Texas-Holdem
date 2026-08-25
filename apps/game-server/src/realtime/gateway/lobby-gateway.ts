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
} from "@texas-holdem/protocol";

import { hashPayload, type IdempotencyStore } from "../../http/middleware/idempotency";
import type { IdSource } from "../../rooms/id-source";
import { RoomDomainError } from "../../rooms/room-errors";
import type { RoomManager } from "../../rooms/room-manager";

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
}

interface ActiveConnection {
  readonly connectionId: string;
  replace(): void;
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
  const clock = options.clock ?? systemClock;

  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    let roomId: string | null = null;
    let playerId: string | null = null;
    let connectionId: string | null = null;
    let connectionKey: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: unknown | null = null;
    let lastActivityAt = options.now();
    let membershipRevoked = false;
    let authenticated = false;

    const authTimer = clock.setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_CODES.AUTH_FAILED, "authenticate within five seconds");
    }, 5_000);

    const isCurrentConnection = (): boolean => connectionKey !== null && connectionId !== null && activeConnections.get(connectionKey)?.connectionId === connectionId;
    const send = (type: "ERROR" | "RECONNECT_RESULT" | "ROOM_SNAPSHOT" | "COMMAND_RESULT" | "SESSION_REPLACED", payload: unknown): void => {
      if (socket.readyState !== socket.OPEN) return;
      const message = ServerMessageSchema.parse({ type, protocolVersion: PROTOCOL_VERSION, serverTime: options.now(), payload });
      socket.send(JSON.stringify(message));
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
      if (isCurrentConnection() && connectionKey !== null && roomId !== null && playerId !== null) {
        activeConnections.delete(connectionKey);
        void manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "DISCONNECTED" }).catch(() => undefined);
      }
    });

    async function applyMutation(command: LobbyMutation): Promise<void> {
      const key = `player:${playerId as string}:ws:${command.requestId}`;
      const payloadHash = hashPayload({ type: command.type, payload: command.payload });
      try {
        const outcome = await options.idempotency.run(key, payloadHash, async () => {
          if (command.type === "SET_READY") {
            await manager.submitCommand(roomId as string, { type: "SET_READY", playerId: playerId as string, ready: command.payload.ready });
          } else {
            await manager.submitCommand(roomId as string, { type: "LEAVE", playerId: playerId as string, reason: "USER_LEFT", leftAt: options.now() });
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
        try {
          roomId = command.payload.roomId;
          playerId = manager.authenticate(roomId, command.payload.playerToken);
          const pendingConnectionKey = `${roomId}:${playerId}`;
          await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "CONNECTED" });
          // The authentication timeout can close this socket while the room queue is busy.
          if (socket.readyState !== socket.OPEN) {
            if (!activeConnections.has(pendingConnectionKey)) {
              await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "DISCONNECTED" });
            }
            return;
          }
          const roomSnapshot = manager.getSnapshot(roomId);
          if (roomSnapshot === undefined) throw new RoomDomainError("ROOM_NOT_FOUND");

          connectionId = options.ids.uuid();
          connectionKey = pendingConnectionKey;
          const previous = activeConnections.get(connectionKey);
          activeConnections.set(connectionKey, { connectionId, replace });
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
          send("RECONNECT_RESULT", { connectionId, resumed: false, tookOver: previous !== undefined, roomSnapshot, gameSnapshot: null });
          previous?.replace();
          startHeartbeat();
        } catch (error) {
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
        case "REQUEST_SNAPSHOT": {
          const snapshot = manager.getSnapshot(roomId as string);
          if (snapshot !== undefined && snapshot.players.some((player) => player.playerId === playerId)) send("ROOM_SNAPSHOT", snapshot);
          else revokeMembership();
          return;
        }
        default:
          sendError("INVALID_MESSAGE");
      }
    }
  });
}

function rejectedResult(requestId: string, code: ErrorCode, traceId: string): CommandResultPayload {
  return {
    requestId,
    status: "REJECTED",
    duplicate: false,
    error: createProtocolError(code, traceId, { retryable: code === "GAME_UNAVAILABLE" }),
  };
}
