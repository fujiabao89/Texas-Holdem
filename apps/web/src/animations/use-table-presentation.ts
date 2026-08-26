"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { WebSocketTransport } from "../protocol/websocket-transport";
import type { ProjectionStore } from "../state/projection-store";
import { AnimationQueue, type PresentationState } from "./animation-queue";

const emptyPresentation: PresentationState = { game: null, overlay: null, mode: "NORMAL" };

/** Connects presentation to the single canonical ProjectionStore lifecycle. */
export function useTablePresentation(projection: ProjectionStore, websocket: WebSocketTransport): PresentationState {
  const [queue] = useState(() => new AnimationQueue({ onHardForward: () => { websocket.requestAuthoritativeSnapshot("MANUAL"); } }));
  const presentation = useSyncExternalStore(queue.subscribe, queue.getSnapshot, () => emptyPresentation);

  useEffect(() => {
    queue.alignToSnapshot(projection.getSnapshot().game);
    const unsubscribeBarrier = projection.subscribeBarriers((barrier) => queue.alignToSnapshot(barrier.game));
    const unsubscribeEvents = projection.subscribeAcceptedGameEvents((event) => queue.enqueue(event.message, event.afterCanonical));
    return () => { unsubscribeEvents(); unsubscribeBarrier(); queue.cancel(); };
  }, [projection, queue]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => queue.setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [queue]);

  return presentation;
}
