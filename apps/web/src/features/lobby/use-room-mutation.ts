"use client";

import { useEffect, useRef, useState } from "react";
import type { UpdateRoomRequest } from "@texas-holdem/protocol";
import { errorMessage, message } from "../../messages/zh-CN";
import { useRoomClient } from "./room-client";

/** One in-flight control-plane request; unchanged failed payloads retain their key. */
export function useRoomMutation(roomId: string) {
  const { http, projection, tokens, websocket, connectionState } = useRoomClient();
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => { inFlight.current?.abort(); inFlight.current = null; }, [roomId]);
  const retry = useRef<{ identity: string; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const run = async (operation: UpdateRoomRequest["operation"] | "START") => {
    if (inFlight.current !== null) return null;
    if (connectionState !== "CONNECTED") { setFeedback(message("room.disconnected")); return null; }
    const room = projection.getSnapshot().room;
    if (room === null || room.roomId !== roomId) return null;
    const request = { expectedRoomRevision: room.roomRevision, ...(operation === "START" ? {} : { operation }) };
    const identity = JSON.stringify({ roomId, operation, request });
    const controller = new AbortController();
    const options = { signal: controller.signal, idempotencyKey: retry.current?.identity === identity ? retry.current.key : undefined };
    inFlight.current = controller;
    setPending(true); setFeedback(null);
    try {
      const result = operation === "START"
        ? await http.startTournament(roomId, { expectedRoomRevision: room.roomRevision }, options)
        : await http.updateRoom(roomId, { expectedRoomRevision: room.roomRevision, operation }, options);
      if (controller.signal.aborted) return null;
      if (!result.ok) {
        retry.current = result.error.retryable && result.idempotencyKey !== undefined ? { identity, key: result.idempotencyKey } : null;
        setFeedback(result.error.reason === "TIMEOUT" ? message("room.errorTimeout") : errorMessage(result.error.code));
        if (result.error.code === "STALE_ROOM_STATE") {
          const token = tokens.get(roomId);
          if (token !== null) websocket.connect(roomId, token);
        }
        return null;
      }
      retry.current = null;
      projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
      // An HTTP reply may arrive after a newer WS snapshot: use the accepted state.
      return projection.getSnapshot().room;
    } catch {
      if (controller.signal.aborted) return null;
      setFeedback(errorMessage("INVALID_MESSAGE"));
      return null;
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  };
  return { run, pending, feedback, setFeedback };
}
