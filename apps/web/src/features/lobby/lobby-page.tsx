"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { RoomSnapshot, TournamentConfig } from "@texas-holdem/protocol";

import { errorMessage, message } from "../../messages/zh-CN";
import { primaryButton } from "./room-flows";
import { useLobbyConnection, useRoomClient, useRoomSnapshot } from "./room-client";

export function LobbyPage({ roomId }: { readonly roomId: string }) {
  const router = useRouter();
  const { http, projection, tokens, websocket, connectionState } = useRoomClient();
  const room = useRoomSnapshot();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useLobbyConnection(roomId);
  if (tokens.get(roomId) === null) return <LobbyFrame><p role="alert">{message("room.missingSession")}</p><Link className="underline" href="/join">{message("room.joinTitle")}</Link></LobbyFrame>;
  if (room === null || room.roomId !== roomId) return <LobbyFrame><p aria-live="polite">{message("room.loading")}</p></LobbyFrame>;
  if (room.status === "CLOSED") return <LobbyFrame><p role="alert">{message("room.closed")}</p><Link className="underline" href="/">{message("room.back")}</Link></LobbyFrame>;
  const playerId = tokens.getPlayerId(roomId);
  const self = room.players.find((player) => player.playerId === playerId);
  const isHost = playerId !== null && room.hostPlayerId === playerId;
  const locked = room.status !== "LOBBY";
  const seats = Array.from({ length: room.config.maxPlayers }, (_, seat) => room.players.find((player) => player.seat === seat) ?? null);
  const update = async (operation: Parameters<typeof http.updateRoom>[1]["operation"]) => {
    setPending(true); setFeedback(null);
    const result = await http.updateRoom(roomId, { expectedRoomRevision: room.roomRevision, operation });
    setPending(false);
    if (!result.ok) { setFeedback(errorMessage(result.error.code)); return; }
    projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
  };
  const setReady = () => {
    if (connectionState !== "CONNECTED") { setFeedback(message("room.disconnected")); return; }
    const command = websocket.prepareCommand({ type: "SET_READY", payload: { ready: !(self?.ready ?? false) } });
    websocket.send(command);
  };
  const start = async () => {
    setPending(true); setFeedback(null);
    const result = await http.startTournament(roomId, { expectedRoomRevision: room.roomRevision });
    setPending(false);
    if (!result.ok) { setFeedback(errorMessage(result.error.code)); return; }
    projection.acceptRoomSnapshot(result.data.data.roomSnapshot);
    router.push(`/room/${roomId}/table`);
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setFeedback(message("room.copied")); } catch { setFeedback(message("room.copyFailed")); }
  };
  const allReady = room.players.length >= 2 && room.players.every((player) => player.seat !== null && player.ready);
  return <LobbyFrame>
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-bold">{message("room.lobbyTitle")}</h1><p aria-live="polite" className="text-sm">{connectionState === "CONNECTED" ? message("room.connected") : connectionState === "CLOSED" ? message("room.disconnected") : message("room.connecting")}</p></div>
    {locked && <p className="rounded bg-amber-50 p-3 text-sm" role="status">{message("room.locked")}</p>}
    <section className="grid gap-3" aria-labelledby="seats-heading"><h2 id="seats-heading" className="text-xl font-semibold">{message("room.seats")}</h2><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{seats.map((player, seat) => <div className="flex min-h-20 items-center justify-between rounded border border-neutral-200 p-3" key={seat}>{player === null ? <><span>{message("room.emptySeat")}</span>{!locked && <button className="underline" disabled={pending} onClick={() => void update({ type: "CHANGE_SEAT", seat })}>{message("room.selectSeat")}</button>}</> : <div><p>{player.displayName}{player.playerId === room.hostPlayerId ? ` · ${message("room.host")}` : ""}</p><p className="text-sm text-neutral-600">{player.ready ? message("room.readyState") : message("room.notReady")}{player.connectionStatus === "DISCONNECTED" ? ` · ${message("room.disconnectedMember")}` : ""}</p></div>}</div>)}</div>
      {!locked && <div className="flex flex-wrap gap-2"><button className="rounded border px-3 py-2" disabled={pending || seats.every((player) => player !== null)} onClick={() => void update({ type: "CHANGE_SEAT", seat: seats.findIndex((player) => player === null) })}>{message("room.randomSeat")}</button>{self?.seat !== null && <button className="rounded border px-3 py-2" disabled={pending} onClick={() => void update({ type: "CHANGE_SEAT", seat: null })}>{message("room.leaveSeat")}</button>}<button className="rounded border px-3 py-2" disabled={pending || connectionState !== "CONNECTED"} onClick={setReady}>{self?.ready ? message("room.unready") : message("room.ready")}</button></div>}
    </section>
    <section className="grid gap-2" aria-labelledby="invite-heading"><h2 id="invite-heading" className="text-xl font-semibold">{message("room.invite")}</h2><p>{room.inviteCode ?? message("room.closed")}</p><div className="flex flex-wrap gap-2">{room.inviteCode !== null && <><button className="rounded border px-3 py-2" onClick={() => void copy(room.inviteCode as string)}>{message("room.copyCode")}</button><button className="rounded border px-3 py-2" onClick={() => void copy(`${window.location.origin}/join?code=${room.inviteCode}`)}>{message("room.copyLink")}</button></>}</div></section>
    <section aria-labelledby="config-heading"><h2 id="config-heading" className="text-xl font-semibold">{message("room.roomConfig")}</h2><dl className="mt-2 grid grid-cols-2 gap-2 text-sm"><dt>{message("room.maxPlayers")}</dt><dd>{room.config.maxPlayers}</dd><dt>{message("room.startingStack")}</dt><dd>{room.config.startingStack}</dd><dt>{message("room.smallBlind")}</dt><dd>{room.config.smallBlind}</dd><dt>{message("room.bigBlind")}</dt><dd>{room.config.bigBlind}</dd></dl></section>
    {isHost && !locked && <section className="grid gap-3" aria-labelledby="host-heading"><h2 id="host-heading" className="text-xl font-semibold">{message("room.hostControls")}</h2><HostConfigEditor room={room} onSave={(config) => void update({ type: "UPDATE_CONFIG", config })} disabled={pending} /><button className={primaryButton} disabled={!allReady || pending} onClick={() => void start()}>{message("room.start")}</button>{!allReady && <p className="text-sm text-neutral-600">{message("room.startNeedPlayers")}</p>}<div className="grid gap-2">{room.players.filter((player) => player.playerId !== room.hostPlayerId).map((player) => <button className="w-fit rounded border border-red-300 px-3 py-2 text-sm" key={player.playerId} disabled={pending} onClick={() => void update({ type: "KICK_PLAYER", targetPlayerId: player.playerId })}>{message("room.kick")}：{player.displayName}</button>)}</div></section>}
    {feedback !== null && <p className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm" role="status">{feedback}</p>}
  </LobbyFrame>;
}

function LobbyFrame({ children }: { readonly children: ReactNode }) { return <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 bg-white p-5 text-neutral-900">{children}</main>; }

function HostConfigEditor({ room, onSave, disabled }: { readonly room: RoomSnapshot; readonly onSave: (config: TournamentConfig) => void; readonly disabled: boolean }) {
  const [config, setConfig] = useState(room.config);
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(config); };
  return <form className="grid grid-cols-2 gap-2" onSubmit={submit}>
    <label className="grid gap-1 text-sm">{message("room.maxPlayers")}<input className="rounded border px-2 py-1" type="number" min={2} max={10} value={config.maxPlayers} onChange={(event) => setConfig((value) => ({ ...value, maxPlayers: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.startingStack")}<input className="rounded border px-2 py-1" type="number" min={1} value={config.startingStack} onChange={(event) => setConfig((value) => ({ ...value, startingStack: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.smallBlind")}<input className="rounded border px-2 py-1" type="number" min={1} value={config.smallBlind} onChange={(event) => setConfig((value) => ({ ...value, smallBlind: Number(event.target.value), blindStructure: [{ ...value.blindStructure[0]!, smallBlind: Number(event.target.value) }] }))} /></label>
    <label className="grid gap-1 text-sm">{message("room.bigBlind")}<input className="rounded border px-2 py-1" type="number" min={2} value={config.bigBlind} onChange={(event) => setConfig((value) => ({ ...value, bigBlind: Number(event.target.value), blindStructure: [{ ...value.blindStructure[0]!, bigBlind: Number(event.target.value) }] }))} /></label>
    <button className="col-span-2 rounded border px-3 py-2" disabled={disabled} type="submit">{message("room.saveConfig")}</button>
  </form>;
}
