import { afterEach, expect, it, vi } from "vitest";
import { ClientCommandSchema } from "../../packages/protocol/src";
import { sendPressureBatch } from "./pressure-probe";

afterEach(() => vi.unstubAllGlobals());

it("sends only protocol-valid pressure commands with the observed snapshot sequence", async () => {
  const messages: unknown[] = [];
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("window", {
    __texPressureSocket: {
      readyState: 1,
      bufferedAmount: 0,
      send: (raw: string) => messages.push(JSON.parse(raw)),
    },
  });
  const result = await sendPressureBatch({ tournamentId: "tournament-1", lastSequence: "42" });
  expect(result).toEqual({ sent: 256, snapshotRequests: 64 });
  const commands = messages.map((message) => ClientCommandSchema.parse(message));
  for (const command of commands) {
    if (command.type === "REQUEST_SNAPSHOT")
      expect(command.payload).toEqual({
        tournamentId: "tournament-1",
        lastSequence: "42",
        reason: "MANUAL",
      });
    else expect(command.type).toBe("TIME_SYNC");
  }
  expect(new Set(commands.map((command) => command.requestId)).size).toBe(commands.length);
});

it("stops adding pressure once the native send buffer reaches its bound", async () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(() => {
      socket.bufferedAmount = 256 * 1024;
    }),
  };
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("window", { __texPressureSocket: socket });
  expect(await sendPressureBatch({ tournamentId: "tournament-1", lastSequence: "42" })).toEqual({
    sent: 1,
    snapshotRequests: 1,
  });
  expect(socket.send).toHaveBeenCalledTimes(1);
});
