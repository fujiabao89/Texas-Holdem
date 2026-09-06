"use client";

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import type { GameEvent } from "@texas-holdem/protocol";

import type { WebSocketTransport } from "../protocol/websocket-transport";
import type { ProjectionStore } from "../state/projection-store";
import { usePresentationPreferences } from "../state/use-presentation-preferences";
import { AnimationQueue, type PresentationState } from "./animation-queue";
import { FrameHealth } from "./frame-health";

const emptyPresentation: PresentationState = { game: null, overlay: null, mode: "NORMAL", holeDeal: null, revealedPlayerIds: [], outcomeEvents: [], notice: null, reducedMotion: false };

/** Connects presentation to the single canonical ProjectionStore lifecycle. */
export function useTablePresentation(
  projection: ProjectionStore,
  websocket: WebSocketTransport,
  onEventStarted?: (event: GameEvent, options?: { readonly immediate: boolean }) => void,
  onPresentationReset?: () => void,
): PresentationState {
  const { motion } = usePresentationPreferences();
  const eventStarted = useEffectEvent((event: GameEvent, options?: { readonly immediate: boolean }) => onEventStarted?.(event, options));
  const reset = useEffectEvent(() => onPresentationReset?.());
  const [queue] = useState(() => new AnimationQueue({
    onHardForward: () => { websocket.requestAuthoritativeSnapshot("MANUAL"); },
  }));
  const [frameHealth] = useState(() => new FrameHealth());
  const presentation = useSyncExternalStore(queue.subscribe, queue.getSnapshot, () => emptyPresentation);
  const hasOverlay = presentation.overlay !== null;

  useEffect(() => {
    queue.setCallbacks({
      onEventStarted: (event, options) => eventStarted(event, options),
      onPresentationReset: () => reset(),
    });
  }, [queue]);

  useEffect(() => {
    queue.alignToSnapshot(projection.getSnapshot().game);
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      queue.setForeground(visible);
      frameHealth.resetWindow();
      if (visible) {
        queue.alignToSnapshot(projection.getSnapshot().game);
        websocket.requestAuthoritativeSnapshot("MANUAL");
      }
    };
    queue.setForeground(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribeBarrier = projection.subscribeBarriers((barrier) => queue.alignToSnapshot(barrier.game));
    const unsubscribeEvents = projection.subscribeAcceptedGameEvents((event) => queue.enqueue(event.message, event.afterCanonical));
    return () => { document.removeEventListener("visibilitychange", onVisibility); unsubscribeEvents(); unsubscribeBarrier(); queue.cancel(); };
  }, [projection, queue, websocket, frameHealth]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => queue.setReducedMotion(query.matches || motion === "reduce" || frameHealth.isDegraded());
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [queue, motion, frameHealth]);

  useEffect(() => {
    if (!hasOverlay || presentation.reducedMotion) return;
    let frame = 0;
    const sample = (now: number) => {
      if (document.visibilityState !== "visible") { frameHealth.resetWindow(); return; }
      if (frameHealth.sample(now)) { queue.setReducedMotion(true); return; }
      frame = window.requestAnimationFrame(sample);
    };
    frameHealth.resetWindow();
    frame = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(frame);
  }, [hasOverlay, presentation.reducedMotion, frameHealth, queue]);

  return presentation;
}
