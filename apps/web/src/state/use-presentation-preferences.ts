"use client";

import { useSyncExternalStore } from "react";

import { presentationPreferences } from "./presentation-preferences";

/** The table and Settings share the same persisted, hydration-safe snapshot. */
export function usePresentationPreferences() {
  return useSyncExternalStore(
    presentationPreferences.subscribe,
    presentationPreferences.getSnapshot,
    presentationPreferences.getServerSnapshot,
  );
}
