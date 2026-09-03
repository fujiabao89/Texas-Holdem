"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSyncExternalStore } from "react";

import type { RoomSnapshot } from "@texas-holdem/protocol";

import { HttpTransport } from "../../protocol/http-transport";
import { PlayerTokenStore } from "../../protocol/token-store";
import { WebSocketTransport, type ConnectionState, type WebSocketLike } from "../../protocol/websocket-transport";
import { ProjectionStore } from "../../state/projection-store";

export interface RoomClient {
  readonly http: HttpTransport;
  readonly projection: ProjectionStore;
  readonly tokens: PlayerTokenStore;
  readonly websocket: WebSocketTransport;
  readonly connectionState: ConnectionState;
}

const RoomClientContext = createContext<RoomClient | null>(null);

export function RoomClientProvider({ children }: { readonly children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("IDLE");
  const client = useMemo<RoomClient>(() => {
    const projection = new ProjectionStore();
    const tokens = new PlayerTokenStore();
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? browserOrigin();
    const websocket = new WebSocketTransport({
      wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? `${apiBaseUrl.replace(/^http/, "ws")}/api/v1/ws`,
      socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      createUuid: () => crypto.randomUUID(),
      projectionStore: projection,
      tokenStore: tokens,
      onConnectionState: setConnectionState,
    });
    return {
      http: new HttpTransport({ apiBaseUrl, tokenStore: tokens, createUuid: () => crypto.randomUUID() }),
      projection,
      tokens,
      websocket,
      connectionState,
    };
  // The runtime owns the callback state only; it is intentionally constructed once per tab.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <RoomClientContext.Provider value={{ ...client, connectionState }}>{children}</RoomClientContext.Provider>;
}

export function useRoomClient(): RoomClient {
  const client = useContext(RoomClientContext);
  if (client === null) throw new Error("RoomClientProvider is required");
  return client;
}

export function useRoomSnapshot(): RoomSnapshot | null {
  const { projection } = useRoomClient();
  return useSyncExternalStore(projection.subscribe, () => projection.getSnapshot().room, () => null);
}

export function useLobbyConnection(roomId: string): void {
  const { tokens, websocket } = useRoomClient();
  useEffect(() => {
    const token = tokens.get(roomId);
    if (token !== null) websocket.connect(roomId, token);
    const retryNow = () => websocket.reconnectNow();
    const onVisibilityChange = () => { if (document.visibilityState === "visible") retryNow(); };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      websocket.disconnect();
    };
  }, [roomId, tokens, websocket]);
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
}
