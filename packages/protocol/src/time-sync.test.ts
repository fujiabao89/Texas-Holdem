import { describe, expect, it } from "vitest";
import {
  ClientCommandSchema,
  ServerMessageSchema,
  PROTOCOL_VERSION,
  validateClientCommand,
  validateServerMessage,
} from "./index";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const command = { type: "TIME_SYNC", requestId, payload: { clientSentAt: 100.25 } };
const response = {
  type: "TIME_SYNC_RESULT",
  protocolVersion: PROTOCOL_VERSION,
  serverTime: 1_020,
  payload: { requestId, clientSentAt: 100.25, serverReceivedAt: 1_000, serverSentAt: 1_020 },
};

describe("wire v6 time sync", () => {
  it("uses strict shared contracts and preserves fractional monotonic client time", () => {
    expect(ClientCommandSchema.parse(command)).toEqual(command);
    expect(ServerMessageSchema.parse(response)).toEqual(response);
    expect(
      ClientCommandSchema.safeParse({ ...command, payload: { ...command.payload, receivedAt: 1 } })
        .success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        ...response,
        payload: { ...response.payload, token: "secret" },
      }).success,
    ).toBe(false);
  });
  it.each([-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid client time %s",
    (clientSentAt) => {
      expect(ClientCommandSchema.safeParse({ ...command, payload: { clientSentAt } }).success).toBe(
        false,
      );
    },
  );
  it("rejects regressing server timestamps, mismatched envelopes and old/future versions", () => {
    expect(
      ServerMessageSchema.safeParse({
        ...response,
        payload: { ...response.payload, serverSentAt: 999 },
      }).success,
    ).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...response, serverTime: 1_021 }).success).toBe(false);
    for (const protocolVersion of [5, 7]) {
      expect(
        validateClientCommand({
          type: "AUTHENTICATE",
          protocolVersion,
          requestId,
          payload: { roomId: "room-1", playerToken: "x".repeat(43) },
        }),
      ).toMatchObject({ success: false, errorCode: "UNSUPPORTED_PROTOCOL_VERSION" });
      expect(validateServerMessage({ ...response, protocolVersion })).toMatchObject({
        success: false,
        errorCode: "UNSUPPORTED_PROTOCOL_VERSION",
      });
    }
  });
});
