import type { ClientCommand } from "../../packages/protocol/src";

/** Serialized by Playwright; only browser globals may be used at runtime. */
export async function sendPressureBatch({
  tournamentId,
  lastSequence,
}: {
  readonly tournamentId: string;
  readonly lastSequence: string;
}) {
  const socket = (window as unknown as { __texPressureSocket?: WebSocket }).__texPressureSocket;
  if (socket?.readyState !== WebSocket.OPEN) return { sent: 0, snapshotRequests: 0 };
  let sent = 0;
  let snapshotRequests = 0;
  while (sent < 256 && socket.bufferedAmount < 256 * 1024) {
    socket.send(
      JSON.stringify({
        type: "REQUEST_SNAPSHOT",
        requestId: crypto.randomUUID(),
        payload: { tournamentId, lastSequence, reason: "MANUAL" },
      } satisfies ClientCommand),
    );
    snapshotRequests++;
    sent++;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return { sent, snapshotRequests };
}
