"use client";

import { useState, type FormEvent } from "react";
import type { RoomSnapshot, TournamentConfig } from "@texas-holdem/protocol";

import { formatMessage, message } from "../../messages/zh-CN";
import { avatarInitial, formatChips, lobbyStartChecklist, type LobbyStartCheckKey } from "./lobby-view";
import { updateInitialBlind } from "./room-presets";

type RoomPlayer = RoomSnapshot["players"][number];

export interface LobbySidebarProps {
  readonly room: RoomSnapshot;
  readonly selfId: string;
  readonly isHost: boolean;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly onSaveConfig: (config: TournamentConfig) => void;
  readonly onKick: (targetPlayerId: string) => void;
}

const checkLabelKey: Record<LobbyStartCheckKey, Parameters<typeof message>[0]> = {
  lobby: "room.checkLobby",
  players: "room.checkPlayers",
  online: "room.checkOnline",
  seated: "room.checkSeated",
  ready: "room.checkReady",
};

/** TEX-68: right-hand preparation rail aligned with the approved demo. */
export function LobbySidebar(props: LobbySidebarProps) {
  const { room, selfId, isHost, locked, disabled, onSaveConfig, onKick } = props;
  const [editing, setEditing] = useState(false);
  const checks = lobbyStartChecklist(room);
  const metCount = checks.filter((item) => item.met).length;
  const unmetCount = checks.length - metCount;
  const unseated = room.players.filter((player) => player.seat === null);
  const seated = room.players.filter((player) => player.seat !== null).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  const actionTime = room.config.actionTime === "UNLIMITED"
    ? message("brand.unlimited")
    : formatMessage("brand.seconds", { value: room.config.actionTime });
  const showEditor = isHost && !locked && editing;

  return <aside className="lobby-sidebar">
    {!locked && <section className="lobby-side-card" aria-labelledby="checklist-heading">
      <div className="lobby-card-head">
        <h2 id="checklist-heading">{message("room.startChecklist")}</h2>
        <span className="lobby-checklist-badge" data-ready={unmetCount === 0}>
          {unmetCount === 0
            ? formatMessage("room.checklistAllMet", { met: metCount, total: checks.length })
            : formatMessage("room.checklistPending", { count: unmetCount })}
        </span>
      </div>
      <ul className="lobby-checklist" aria-live="polite">
        {checks.map((item) => <li className="lobby-check-item" data-met={item.met} key={item.key}>
          <div className="lobby-check-head">
            <span className="lobby-check-mark" aria-hidden="true">✓</span>
            <span className="lobby-check-label">{message(checkLabelKey[item.key])}</span>
          </div>
          {item.reasons.length > 0 && <ul className="lobby-check-reasons">
            {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>}
        </li>)}
      </ul>
    </section>}

    <section className="lobby-side-card" aria-labelledby="config-heading">
      <div className="lobby-card-head">
        <h2 id="config-heading">{message("room.structure")}</h2>
        {isHost && !locked && <button
          className="lobby-inline-toggle"
          type="button"
          aria-expanded={showEditor}
          aria-controls="lobby-rules-editor"
          onClick={() => setEditing((open) => !open)}
        >{message(showEditor ? "room.closeRules" : "room.editRules")}</button>}
      </div>
      <dl className="lobby-structure-grid">
        <div className="lobby-structure-cell"><dt>{message("room.maxPlayers")}</dt><dd>{formatMessage("room.playersValue", { count: room.config.maxPlayers })}</dd></div>
        <div className="lobby-structure-cell"><dt>{message("room.startingStack")}</dt><dd>{formatChips(room.config.startingStack)}</dd></div>
        <div className="lobby-structure-cell"><dt>{message("room.blinds")}</dt><dd>{formatMessage("room.blindsValue", { small: formatChips(room.config.smallBlind), big: formatChips(room.config.bigBlind) })}</dd></div>
        <div className="lobby-structure-cell"><dt>{message("room.actionTime")}</dt><dd>{actionTime}</dd></div>
      </dl>
      {showEditor && <div id="lobby-rules-editor" className="lobby-rules-editor">
        <HostConfigEditor
          key={JSON.stringify(room.config)}
          room={room}
          disabled={disabled}
          onCancel={() => setEditing(false)}
          onSave={(config) => { onSaveConfig(config); setEditing(false); }}
        />
      </div>}
    </section>

    <section className="lobby-side-card" aria-labelledby="members-heading">
      <div className="lobby-card-head">
        <h2 id="members-heading">{message("room.members")}</h2>
        <span className="lobby-member-count">{formatMessage("room.membersInRoom", { count: room.players.length })}</span>
      </div>
      {unseated.length > 0 && <section className="lobby-unseated-section" aria-label={message("room.unseatedMembers")}>
        <h3 className="lobby-subgroup-title">{message("room.unseatedMembers")}</h3>
        <ul className="lobby-member-list">
          {unseated.map((player) => <MemberRow key={player.playerId} player={player} room={room} selfId={selfId} isHost={isHost} locked={locked} disabled={disabled} onKick={onKick} />)}
        </ul>
      </section>}
      {seated.length > 0 && <ul className="lobby-member-list">
        {seated.map((player) => <MemberRow key={player.playerId} player={player} room={room} selfId={selfId} isHost={isHost} locked={locked} disabled={disabled} onKick={onKick} />)}
      </ul>}
    </section>
  </aside>;
}

function MemberRow({ player, room, selfId, isHost, locked, disabled, onKick }: {
  readonly player: RoomPlayer;
  readonly room: RoomSnapshot;
  readonly selfId: string;
  readonly isHost: boolean;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly onKick: (targetPlayerId: string) => void;
}) {
  const online = player.connectionStatus === "CONNECTED";
  const host = player.playerId === room.hostPlayerId;
  const self = player.playerId === selfId;
  const canKick = isHost && !locked && !host;
  const seatText = player.seat === null ? message("room.unseated") : formatMessage("brand.seatNumber", { number: player.seat + 1 });
  return <li className="lobby-member-row" data-online={online} data-ready={player.ready}>
    <span className="lobby-member-avatar" aria-hidden="true">{avatarInitial(player.displayName)}</span>
    <div className="lobby-member-info">
      <p className="lobby-member-name">
        <span className="lobby-member-name-text">{player.displayName}</span>
        {host && <span className="lobby-member-tag lobby-member-tag-host">{message("room.host")}</span>}
        {self && <span className="lobby-member-tag lobby-member-tag-self">{message("table.you")}</span>}
      </p>
      <p className="lobby-member-meta">
        <span>{online ? message("room.onlineMember") : message("room.disconnectedMember")}</span>
        <span aria-hidden="true">·</span>
        <span>{seatText}</span>
        <span aria-hidden="true">·</span>
        <span className={player.ready ? "lobby-member-ready" : ""}>{player.ready ? message("room.readyState") : message("room.notReady")}</span>
      </p>
    </div>
    <div className="lobby-member-end">
      <span className="lobby-member-dot" data-ready={player.ready} aria-hidden="true" />
      {canKick && <button
        className="lobby-kick-button"
        type="button"
        disabled={disabled}
        aria-label={formatMessage("room.kickLabel", { name: player.displayName })}
        onClick={() => onKick(player.playerId)}
      >{message("room.kickShort")}</button>}
    </div>
  </li>;
}

function HostConfigEditor({ room, onSave, onCancel, disabled }: {
  readonly room: RoomSnapshot;
  readonly onSave: (config: TournamentConfig) => void;
  readonly onCancel: () => void;
  readonly disabled: boolean;
}) {
  const [config, setConfig] = useState(room.config);
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(config); };
  return <form className="grid grid-cols-2 gap-2.5" onSubmit={submit}>
    <label className="grid gap-1 text-xs text-[#536452]">{message("room.maxPlayers")}<input className="rr-input lobby-editor-input" type="number" min={2} max={10} value={config.maxPlayers} onChange={(event) => setConfig((value) => ({ ...value, maxPlayers: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-xs text-[#536452]">{message("room.startingStack")}<input className="rr-input lobby-editor-input" type="number" min={1} value={config.startingStack} onChange={(event) => setConfig((value) => ({ ...value, startingStack: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-xs text-[#536452]">{message("room.smallBlind")}<input className="rr-input lobby-editor-input" type="number" min={1} value={config.smallBlind} onChange={(event) => setConfig((value) => updateInitialBlind(value, { smallBlind: Number(event.target.value) }))} /></label>
    <label className="grid gap-1 text-xs text-[#536452]">{message("room.bigBlind")}<input className="rr-input lobby-editor-input" type="number" min={2} value={config.bigBlind} onChange={(event) => setConfig((value) => updateInitialBlind(value, { bigBlind: Number(event.target.value) }))} /></label>
    <div className="col-span-2 flex items-center justify-end gap-2 pt-1">
      <button className="lobby-btn-outline" type="button" onClick={onCancel}>{message("room.cancel")}</button>
      <button className="lobby-btn-green" disabled={disabled} type="submit">{message("room.saveConfig")}</button>
    </div>
  </form>;
}
