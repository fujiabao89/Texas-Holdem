import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import {
  CLOSE_CODES,
  createProtocolError,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  validateClientCommand,
  type ErrorCode,
  type RoomSnapshot,
} from "@texas-holdem/protocol";

import { RoomDomainError } from "../../rooms/room-errors";
import type { RoomManager } from "../../rooms/room-manager";

/**
 * Minimal Lobby realtime gateway. It only relays server-authoritative RoomSnapshot
 * values; it never constructs room state from a client command or acknowledgement.
 */
export function registerLobbyGateway(app: FastifyInstance, manager: RoomManager, now: () => number): void {
  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    let roomId: string | null = null;
    let playerId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_CODES.AUTH_FAILED, "authenticate within five seconds");
    }, 5_000);

    const send = (type: "ERROR" | "RECONNECT_RESULT" | "ROOM_SNAPSHOT" | "COMMAND_RESULT", payload: unknown): void => {
      if (socket.readyState !== socket.OPEN) return;
      const message = ServerMessageSchema.parse({ type, protocolVersion: PROTOCOL_VERSION, serverTime: now(), payload });
      socket.send(JSON.stringify(message));
    };
    const sendError = (code: ErrorCode): void => {
      send("ERROR", createProtocolError(code, randomUUID(), { retryable: code === "GAME_UNAVAILABLE" || code === "RATE_LIMITED" }));
    };
    const sendRoom = (snapshot: RoomSnapshot): void => send("ROOM_SNAPSHOT", snapshot);

    socket.on("message", (raw: Buffer) => {
      void handleMessage(raw.toString());
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
      if (roomId !== null && playerId !== null) {
        void manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "DISCONNECTED" }).catch(() => undefined);
      }
    });

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
          authenticated = true;
          clearTimeout(authTimer);
          await manager.submitCommand(roomId, { type: "SET_CONNECTION_STATUS", playerId, connectionStatus: "CONNECTED" });
          unsubscribe = manager.subscribe((snapshot) => {
            if (snapshot.roomId === roomId) sendRoom(snapshot);
          });
          const roomSnapshot = manager.getSnapshot(roomId);
          if (roomSnapshot === undefined) throw new RoomDomainError("ROOM_NOT_FOUND");
          send("RECONNECT_RESULT", { connectionId: randomUUID(), resumed: false, tookOver: false, roomSnapshot, gameSnapshot: null });
        } catch (error) {
          sendError(error instanceof RoomDomainError ? error.code : "AUTH_FAILED");
          socket.close(CLOSE_CODES.AUTH_FAILED);
        }
        return;
      }
      if (command.type === "AUTHENTICATE") {
        sendError("INVALID_MESSAGE");
        return;
      }
      try {
        switch (command.type) {
          case "SET_READY":
            await manager.submitCommand(roomId as string, { type: "SET_READY", playerId: playerId as string, ready: command.payload.ready });
            send("COMMAND_RESULT", { requestId: command.requestId, status: "APPLIED", duplicate: false });
            return;
          case "LEAVE_ROOM":
            await manager.submitCommand(roomId as string, { type: "LEAVE", playerId: playerId as string, reason: "USER_LEFT", leftAt: now() });
            send("COMMAND_RESULT", { requestId: command.requestId, status: "APPLIED", duplicate: false });
            return;
          case "REQUEST_SNAPSHOT": {
            const snapshot = manager.getSnapshot(roomId as string);
            if (snapshot !== undefined) sendRoom(snapshot);
            return;
          }
          default:
            sendError("INVALID_MESSAGE");
        }
      } catch (error) {
        const code = error instanceof RoomDomainError ? error.code : "INTERNAL_ERROR";
        send("COMMAND_RESULT", {
          requestId: command.requestId,
          actionId: command.type === "SUBMIT_ACTION" ? command.payload.actionId : undefined,
          status: "REJECTED",
          duplicate: false,
          error: createProtocolError(code, randomUUID(), { retryable: code === "GAME_UNAVAILABLE" }),
        });
      }
    }
  });
}
