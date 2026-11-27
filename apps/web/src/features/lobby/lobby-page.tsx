"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { errorMessage, message } from "../../messages/zh-CN";
import { useLobbyConnection, useRoomClient } from "./room-client";
import { useRoomMutation } from "./use-room-mutation";
import { lobbyInviteCode, lobbyReadiness, lobbySeats, lobbyStartBlockers } from "./lobby-view";
import { LobbyTable } from "./lobby-table";
import { LobbySidebar } from "./lobby-sidebar";
import { useProjectionState } from "../../state/use-projection-state";
import { usePresentationPreferences } from "../../state/use-presentation-preferences";
import { visualTimings } from "../../animations/timings";

export function LobbyPage({ roomId }: { readonly roomId: string }) {
  const { projection, tokens, websocket, connectionState } = useRoomClient();
  const { room, game } = useProjectionState(projection);
  const { run, pending, feedback, setFeedback } = useRoomMutation(roomId);
  const [readyPending, setReadyPending] = useState(false);
  const readyRequest = useRef<string | null>(null);
  const recoveringTournament = useRef<string | null>(null);
  const router = useRouter();
  const isBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);
  useLobbyConnection(roomId);

  // Enter only after the new tournament's authoritative snapshot has arrived.
  useEffect(() => {
    if (room?.roomId !== roomId || room.status !== "IN_GAME" || room.activeTournamentId === null) {
      recoveringTournament.current = null;
      return;
    }
    if (connectionState !== "CONNECTED") return;
    if (room.activeTournamentId === game?.tournamentId) {
      router.replace(`/room/${roomId}/table`);
    } else if (recoveringTournament.current !== room.activeTournamentId) {
      // The lobby can receive the initial events before it has any game baseline.
      // Authenticate once for the new tournament instead of waiting for ACTION_OPEN.
      const token = tokens.get(roomId);
      if (token !== null) {
        recoveringTournament.current = room.activeTournamentId;
        websocket.connect(roomId, token);
      }
    }
  }, [connectionState, room, game?.tournamentId, roomId, router, tokens, websocket]);
  useEffect(() => websocket.subscribeCommandResults((next, result) => {
    if (next.requestId !== readyRequest.current) return;
    // Rejections release the UI lock; only the snapshot owns Ready.
    if (result.status === "REJECTED" && result.error !== undefined) {
      setFeedback(errorMessage(result.error.code));
      readyRequest.current = null;
      setReadyPending(false);
    }
  }), [websocket, setFeedback]);
  useEffect(() => websocket.subscribeProtocolErrors((code) => setFeedback(errorMessage(code))), [websocket, setFeedback]);
  useEffect(() => {
    let revision = projection.getSnapshot().room?.roomRevision;
    const release = () => { readyRequest.current = null; setReadyPending(false); };
    const stopRoom = projection.subscribe(() => {
      const next = projection.getSnapshot().room?.roomRevision;
      if (next !== revision) { revision = next; release(); }
    });
    const stopBarrier = projection.subscribeBarriers((barrier) => { if (barrier.kind === "RECONNECT_RESULT") release(); });
    return () => { stopRoom(); stopBarrier(); };
  }, [projection]);

  if (!isBrowser) return <LobbyFrame><p aria-live="polite">{message("room.loading")}</p></LobbyFrame>;
  if (room?.roomId === roomId && room.status === "CLOSED") return <LobbyFrame><p role="alert">{message("room.closed")}</p><Link className="underline" href="/">{message("room.back")}</Link></LobbyFrame>;
  if (tokens.get(roomId) === null) return <LobbyFrame><p role="alert">{message("room.missingSession")}</p><Link className="underline" href="/join">{message("room.joinTitle")}</Link></LobbyFrame>;
  if (room === null || room.roomId !== roomId) return <LobbyFrame><p aria-live="polite">{message("room.loading")}</p></LobbyFrame>;
  const playerId = tokens.getPlayerId(roomId);
  const self = room.players.find((player) => player.playerId === playerId);
  if (self === undefined) return <LobbyFrame><p role="alert">{message("table.removed")}</p><Link href="/">{message("room.back")}</Link></LobbyFrame>;
  const isHost = room.hostPlayerId === playerId;
  const locked = room.status !== "LOBBY";
  const disabled = pending || readyPending || connectionState !== "CONNECTED";
  const seats = lobbySeats(room);
  const readiness = lobbyReadiness(room);
  const inviteCode = lobbyInviteCode(room);
  const update = (operation: Parameters<typeof run>[0]) => run(operation);
  const setReady = () => {
    if (readyRequest.current !== null || disabled || locked || self.seat === null) return;
    const command = websocket.prepareCommand({ type: "SET_READY", payload: { ready: !self.ready } });
    readyRequest.current = command.requestId;
    setReadyPending(true); setFeedback(null);
    try { websocket.send(command); }
    catch { readyRequest.current = null; setReadyPending(false); setFeedback(message("room.disconnected")); }
  };
  const start = async () => {
    const current = projection.getSnapshot().room;
    if (current?.roomId !== roomId || current.hostPlayerId !== playerId || lobbyStartBlockers(current).length !== 0 || disabled) return;
    await run("START");
  };
  const copy = async (link: boolean) => {
    const current = projection.getSnapshot().room;
    const code = current?.roomId === roomId ? lobbyInviteCode(current) : null;
    if (code === null) return;
    try { await navigator.clipboard.writeText(link ? `${window.location.origin}/join?code=${code}` : code); setFeedback(message("room.copied")); }
    catch { setFeedback(message("room.copyFailed")); }
  };

  return <LobbyFrame>
    <div className="rr-lobby-header flex flex-wrap items-center justify-between gap-3">
      <div className="lobby-title-block">
        <p className="rr-kicker lobby-kicker">{message("brand.lobbyKicker")}</p>
        <h1 className="text-3xl font-bold">{message("room.lobbyTitle")}</h1>
      </div>
      <p aria-live="polite" className="rr-status" data-connected={connectionState === "CONNECTED"}>{connectionState === "CONNECTED" ? message("room.connected") : message("room.disconnected")}</p>
    </div>
    {locked && <div className="lobby-locked-bar" role="status">
      <p>{message(room.status === "FINISHED" ? "room.finished" : "room.locked")}</p>
      {room.status === "IN_GAME" && <Link className="rr-button" href={`/room/${roomId}/table`}>{message("room.enterTable")}</Link>}
      {room.status === "FINISHED" && game?.tournamentStatus === "FINISHED" && <Link className="rr-button" href={`/room/${roomId}/result/${game.tournamentId}`}>{message("result.view")}</Link>}
    </div>}
    <div className="lobby-workspace">
      <LobbyTable
        room={room}
        self={self}
        seats={seats}
        isHost={isHost}
        locked={locked}
        disabled={disabled}
        inviteCode={inviteCode}
        readiness={readiness}
        feedback={feedback !== null ? <p className="rr-feedback" role="status">{feedback}</p> : null}
        onSelectSeat={(seat) => void update({ type: "CHANGE_SEAT", seat })}
        onToggleReady={setReady}
        onStart={() => void start()}
        onCopy={(link) => void copy(link)}
      />
      <LobbySidebar
        room={room}
        selfId={self.playerId}
        isHost={isHost}
        locked={locked}
        disabled={disabled}
        onSaveConfig={(config) => void update({ type: "UPDATE_CONFIG", config })}
        onKick={(targetPlayerId) => void update({ type: "KICK_PLAYER", targetPlayerId })}
      />
    </div>
  </LobbyFrame>;
}

function LobbyFrame({ children }: { readonly children: ReactNode }) {
  const { motion } = usePresentationPreferences();
  return <main data-reduced-motion={motion === "reduce"} style={{ "--lobby-feedback-duration": `${visualTimings.lobbyFeedback}ms`, "--control-feedback-duration": `${visualTimings.controlFeedback}ms` } as CSSProperties} className="rr-page rr-lobby lobby-controls">{children}</main>;
}

function subscribeNever(): () => void { return () => undefined; }
