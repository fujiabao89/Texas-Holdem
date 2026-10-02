import type { WebSocketRoute } from "@playwright/test";
import {
  ClientCommandSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
} from "../../../packages/protocol/src";
const firstProbe = new WeakMap<WebSocketRoute, number>();

/** Explicit TIME_SYNC responder for projection mocks; network tests supply their own delays. */
export function replyTimeSync(socket: WebSocketRoute, raw: string | Buffer): boolean {
  const command = JSON.parse(raw.toString());
  if (command.type !== "TIME_SYNC") return false;
  const parsed = ClientCommandSchema.parse(command);
  if (parsed.type !== "TIME_SYNC") return false;
  const origin = firstProbe.get(socket) ?? parsed.payload.clientSentAt;
  firstProbe.set(socket, origin);
  const serverTime = Math.floor(parsed.payload.clientSentAt - origin);
  socket.send(
    JSON.stringify(
      ServerMessageSchema.parse({
        type: "TIME_SYNC_RESULT",
        protocolVersion: PROTOCOL_VERSION,
        serverTime,
        payload: {
          requestId: parsed.requestId,
          clientSentAt: parsed.payload.clientSentAt,
          serverReceivedAt: serverTime,
          serverSentAt: serverTime,
        },
      }),
    ),
  );
  return true;
}
