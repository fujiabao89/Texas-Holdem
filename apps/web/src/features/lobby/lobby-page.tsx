"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { RoomSnapshot, TournamentConfig } from "@texas-holdem/protocol";

import { errorMessage, message } from "../../messages/zh-CN";
import { primaryButton } from "./room-flows";
import { useLobbyConnection, useRoomClient } from "./room-client";
import { useRoomMutation } from "./use-room-mutation";
import { lobbyInviteCode, lobbyStartBlockers } from "./lobby-view";
import { useProjectionState } from "../../state/use-projection-state";
import { updateInitialBlind } from "./room-presets";
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
  const seats = Array.from({ length: room.config.maxPlayers }, (_, seat) => room.players.find((player) => player.seat === seat) ?? null);
  const blockers = lobbyStartBlockers(room);
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
  const memberState = (player: RoomSnapshot["players"][number]) => <>
    <p>{player.displayName}{player.playerId === room.hostPlayerId ? ` · ${message("room.host")}` : ""}</p>
    <p className="text-sm text-neutral-600">{player.connectionStatus === "CONNECTED" ? message("room.onlineMember") : message("room.disconnectedMember")} · {player.seat === null ? `${message("room.unseated")} · ` : ""}{player.ready ? message("room.readyState") : message("room.notReady")}</p>
  </>;
  return <LobbyFrame>
    <div className="rr-lobby-header flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-bold">{message("room.lobbyTitle")}</h1><p aria-live="polite" className="rr-status">{connectionState === "CONNECTED" ? message("room.connected") : message("room.disconnected")}</p></div>
    {locked && <p className="rounded bg-amber-50 p-3 text-sm" role="status">{message(room.status === "FINISHED" ? "room.finished" : "room.locked")}</p>}
    {room.status === "IN_GAME" && <Link className="rr-button w-fit" href={`/room/${roomId}/table`}>{message("room.enterTable")}</Link>}
    {room.status === "FINISHED" && game?.tournamentStatus === "FINISHED" && <Link className="rr-button w-fit" href={`/room/${roomId}/result/${game.tournamentId}`}>{message("result.view")}</Link>}
    <section className="rr-panel rr-lobby-seats grid gap-4" aria-labelledby="seats-heading">
      <h2 id="seats-heading" className="text-xl font-semibold">{message("room.seats")}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{seats.map((player, seat) => <div className={`lobby-seat-feedback flex min-h-20 items-center justify-between rounded-xl border p-3 ${player?.ready ? "border-emerald-200 bg-emerald-50" : "border-neutral-200 bg-white"} ${player === null ? "rr-seat-empty" : ""}`} key={`${seat}:${player?.playerId ?? "empty"}:${player?.ready ?? false}`}>
        <span className="rr-seat-number" aria-hidden="true">{seat + 1}</span>{player === null ? <><span>{message("room.emptySeat")}</span>{!locked && <button className="text-sm underline underline-offset-4" disabled={disabled} onClick={() => void update({ type: "CHANGE_SEAT", seat })}>{message("room.selectSeat")}</button>}</> : <div>{memberState(player)}</div>}
      </div>)}</div>
      {room.players.some((player) => player.seat === null) && <section aria-label={message("room.unseatedMembers")}><h3 className="font-semibold">{message("room.unseatedMembers")}</h3><ul className="mt-2 grid gap-2">{room.players.filter((player) => player.seat === null).map((player) => <li key={player.playerId}>{memberState(player)}</li>)}</ul></section>}
      {!locked && <div className="flex flex-wrap gap-2">
        <button className="rr-button" disabled={disabled || seats.every((player) => player !== null)} onClick={() => void update({ type: "CHANGE_SEAT", seat: seats.findIndex((player) => player === null) })}>{message("room.randomSeat")}</button>
        {self.seat !== null && <button className="rr-button" disabled={disabled} onClick={() => void update({ type: "CHANGE_SEAT", seat: null })}>{message("room.leaveSeat")}</button>}
        <button className="rr-button" disabled={disabled || self.seat === null} onClick={setReady}>{self.ready ? message("room.unready") : message("room.ready")}</button>
      </div>}
    </section>
    <section className="rr-panel grid gap-2" aria-labelledby="invite-heading"><h2 id="invite-heading" className="text-xl font-semibold">{message("room.invite")}</h2>
      {inviteCode !== null && <p className="rr-invite-code">{inviteCode}</p>}
      <p>{message(locked ? "room.invitePaused" : "room.inviteAvailable")}</p>
      {inviteCode !== null && <div className="flex flex-wrap gap-2"><button className="rr-button" onClick={() => void copy(false)}>{message("room.copyCode")}</button><button className="rr-button" onClick={() => void copy(true)}>{message("room.copyLink")}</button></div>}
    </section>
    <section className="rr-panel" aria-labelledby="config-heading"><h2 id="config-heading" className="text-xl font-semibold">{message("room.roomConfig")}</h2><dl className="mt-2 grid grid-cols-2 gap-2 text-sm"><dt>{message("room.maxPlayers")}</dt><dd>{room.config.maxPlayers}</dd><dt>{message("room.startingStack")}</dt><dd>{room.config.startingStack}</dd><dt>{message("room.smallBlind")}</dt><dd>{room.config.smallBlind}</dd><dt>{message("room.bigBlind")}</dt><dd>{room.config.bigBlind}</dd></dl></section>
    {isHost && !locked && <section className="rr-panel grid gap-3" aria-labelledby="host-heading"><h2 id="host-heading" className="text-xl font-semibold">{message("room.hostControls")}</h2>
      <HostConfigEditor key={JSON.stringify(room.config)} room={room} onSave={(config) => void update({ type: "UPDATE_CONFIG", config })} disabled={disabled} />
      <button className={primaryButton} disabled={blockers.length !== 0 || disabled} onClick={() => void start()}>{message("room.start")}</button>
      {blockers.length !== 0 && <ul className="text-sm text-neutral-600" aria-live="polite">{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <div className="grid gap-2">{room.players.filter((player) => player.playerId !== room.hostPlayerId).map((player) => <button className="w-fit rounded border border-red-300 px-3 py-2 text-sm" key={player.playerId} disabled={disabled} onClick={() => void update({ type: "KICK_PLAYER", targetPlayerId: player.playerId })}>{message("room.kick")}：{player.displayName}</button>)}</div>
    </section>}
    {feedback !== null && <p className="rr-feedback" role="status">{feedback}</p>}
  </LobbyFrame>;
}

function LobbyFrame({ children }: { readonly children: ReactNode }) {
  const { motion } = usePresentationPreferences();
  return <main data-reduced-motion={motion === "reduce"} style={{ "--lobby-feedback-duration": `${visualTimings.lobbyFeedback}ms`, "--control-feedback-duration": `${visualTimings.controlFeedback}ms` } as CSSProperties} className="rr-page rr-lobby lobby-controls">{children}</main>;
}

function subscribeNever(): () => void { return () => undefined; }

function HostConfigEditor({ room, onSave, disabled }: { readonly room: RoomSnapshot; readonly onSave: (config: TournamentConfig) => void; readonly disabled: boolean }) {
  const [config, setConfig] = useState(room.config);
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(config); };
  return <form className="grid grid-cols-2 gap-2" onSubmit={submit}>
    <label className="grid gap-1 text-sm">{message("room.maxPlayers")}<input className="rr-input" type="number" min={2} max={10} value={config.maxPlayers} onChange={(event) => setConfig((value) => ({ ...value, maxPlayers: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.startingStack")}<input className="rr-input" type="number" min={1} value={config.startingStack} onChange={(event) => setConfig((value) => ({ ...value, startingStack: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.smallBlind")}<input className="rr-input" type="number" min={1} value={config.smallBlind} onChange={(event) => setConfig((value) => updateInitialBlind(value, { smallBlind: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.bigBlind")}<input className="rr-input" type="number" min={2} value={config.bigBlind} onChange={(event) => setConfig((value) => updateInitialBlind(value, { bigBlind: Number(event.target.value) }))} /></label>
    <button className="rr-button col-span-2" disabled={disabled} type="submit">{message("room.saveConfig")}</button>
  </form>;
}
