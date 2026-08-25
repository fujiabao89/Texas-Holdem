"use client";

import { Provider } from "jotai";
import type { ReactNode } from "react";
import { RoomClientProvider } from "../features/lobby/room-client";

export function AppProviders({ children }: { children: ReactNode }) {
  return <Provider><RoomClientProvider>{children}</RoomClientProvider></Provider>;
}
