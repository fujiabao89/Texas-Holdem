"use client";

import { useSyncExternalStore } from "react";

import { ProjectionStore, type ProjectionState } from "./projection-store";

export function useProjectionState(store: ProjectionStore): ProjectionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
