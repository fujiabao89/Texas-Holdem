"use client";

import { useEffect } from "react";

import type { ConnectionState } from "../protocol/websocket-transport";
import type { ProjectionStore } from "../state/projection-store";
import type { AudioController } from "./audio-controller";
import { TableCueTracker } from "./table-cues";

/** Only live accepted canonical differences can announce a turn or blind level. */
export function useTableCues(projection: ProjectionStore, connectionState: ConnectionState, audio: AudioController): void {
  useEffect(() => {
    audio.cancelTableCue();
    if (connectionState !== "CONNECTED") return;
    const tracker = new TableCueTracker();
    tracker.reset(projection.getSnapshot().game);
    const reset = (): void => {
      tracker.reset(projection.getSnapshot().game);
      audio.cancelTableCue();
    };
    const unsubscribeBarrier = projection.subscribeBarriers(reset);
    const unsubscribeEvents = projection.subscribeAcceptedGameEvents(({ afterCanonical }) => {
      const { cue, cancelPending } = tracker.accept(afterCanonical);
      if (cancelPending) audio.cancelTableCue();
      if (cue !== null && !projection.getSnapshot().actionsDisabled && document.visibilityState === "visible") audio.playTableCue(cue);
    });
    document.addEventListener("visibilitychange", reset);
    return () => {
      unsubscribeBarrier();
      unsubscribeEvents();
      document.removeEventListener("visibilitychange", reset);
      audio.cancelTableCue();
    };
  }, [projection, connectionState, audio]);
}
