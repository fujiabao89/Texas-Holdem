"use client";

import type { CSSProperties, ReactNode } from "react";
import type { RoomSnapshot } from "@texas-holdem/protocol";

import { formatMessage, message } from "../../messages/zh-CN";
import { primaryButton } from "./room-flows";
import { lobbyLayoutMetrics, lobbySeatLayout, type LobbySeatPlacement } from "./lobby-seat-layout";
import { avatarInitial, formatChips, type LobbyReadiness } from "./lobby-view";

type RoomPlayer = RoomSnapshot["players"][number];

export interface LobbyTableProps {
  readonly room: RoomSnapshot;
  readonly self: RoomPlayer;
  readonly seats: readonly (RoomPlayer | null)[];
  readonly isHost: boolean;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly inviteCode: string | null;
  readonly readiness: LobbyReadiness;
  readonly feedback: ReactNode;
  readonly onSelectSeat: (seat: number | null) => void;
  readonly onToggleReady: () => void;
  readonly onStart: () => void;
  readonly onCopy: (link: boolean) => void;
}

const { landscape, portrait, chipProtrusion } = lobbyLayoutMetrics;

/** Sizes come from the shared geometry so CSS and the overlap tests never drift. */
const stageMetrics = {
  "--seat-w-l": `${landscape.seatWidth}px`,
  "--seat-h-l": `${landscape.seatHeight}px`,
  "--chip-w-l": `${landscape.chipWidth}px`,
  "--chip-h-l": `${landscape.chipHeight}px`,
  "--felt-aspect-l": String(landscape.feltAspect),
  "--seat-w-p": `${portrait.seatWidth}px`,
  "--seat-h-p": `${portrait.seatHeight}px`,
  "--chip-w-p": `${portrait.chipWidth}px`,
  "--chip-h-p": `${portrait.chipHeight}px`,
  "--felt-aspect-p": String(portrait.feltAspect),
  "--outset-p": `${portrait.sideOutset * 100}%`,
  "--chip-out": `${chipProtrusion * 100}%`,
} as CSSProperties;

/** TEX-68: the lobby as a physical table. Consumes RoomSnapshot only. */
export function LobbyTable(props: LobbyTableProps) {
  const { room, self, seats, isHost, locked, disabled, inviteCode, readiness, feedback } = props;
  const wide = lobbySeatLayout(room.config.maxPlayers, "landscape");
  const tall = lobbySeatLayout(room.config.maxPlayers, "portrait");
  const emptySeat = seats.findIndex((player) => player === null);
  return <section className="lobby-stage" style={stageMetrics} aria-labelledby="seats-heading">
    <h2 id="seats-heading" className="sr-only">{message("room.seats")}</h2>
    <div className="lobby-table-wrap">
      <LobbyPlaque room={room} isHost={isHost} locked={locked} inviteCode={inviteCode} readiness={readiness} onCopy={props.onCopy} />
      <div className="lobby-felt-frame">
        <div className="lobby-felt-area">
          <div className="lobby-felt" aria-hidden="true"><span className="lobby-felt-stitch" /></div>
          <p className="lobby-felt-watermark" aria-hidden="true">{formatMessage("room.blindWatermark", { small: formatChips(room.config.smallBlind), big: formatChips(room.config.bigBlind) })}</p>
          <ol className="lobby-seats">
            {seats.map((player, seat) => <SeatSlot key={seat} seat={seat} wide={wide[seat]} tall={tall[seat]}>
              {player === null
                ? <EmptySeat seat={seat} locked={locked} disabled={disabled} onSelect={() => props.onSelectSeat(seat)} />
                : <SeatCard key={`${player.playerId}:${player.ready}`} seat={seat} player={player} self={player.playerId === self.playerId} host={player.playerId === room.hostPlayerId} stack={room.config.startingStack} />}
            </SeatSlot>)}
          </ol>
        </div>
      </div>
    </div>
    {!locked && <div className="lobby-dock" role="group" aria-label={message("room.dockLabel")}>
      <div className="lobby-dock-secondary">
        <button className="rr-button" disabled={disabled || emptySeat === -1} onClick={() => props.onSelectSeat(emptySeat)}>{message("room.randomSeat")}</button>
        {self.seat !== null && <button className="rr-button" disabled={disabled} onClick={() => props.onSelectSeat(null)}>{message("room.leaveSeat")}</button>}
      </div>
      <div className="lobby-dock-primary">
        <button className="rr-button lobby-ready-button" data-ready={self.ready} disabled={disabled || self.seat === null} onClick={props.onToggleReady}>{self.ready ? message("room.unready") : message("room.ready")}</button>
        {isHost && <button className={`${primaryButton} lobby-start-button`} disabled={!readiness.canStart || disabled} onClick={props.onStart}>{message("room.start")}</button>}
      </div>
    </div>}
    {feedback}
  </section>;
}

function SeatSlot({ seat, wide, tall, children }: { readonly seat: number; readonly wide: LobbySeatPlacement | undefined; readonly tall: LobbySeatPlacement | undefined; readonly children: ReactNode }) {
  const style = { "--lx": `${wide?.x ?? 50}%`, "--ly": `${wide?.y ?? 50}%`, "--px": `${tall?.x ?? 50}%`, "--py": `${tall?.y ?? 50}%` } as CSSProperties;
  return <li className="lobby-seat-slot" data-lobby-seat={seat} data-side={wide?.side ?? "bottom"} data-mside={tall?.side ?? "bottom"} style={style}>{children}</li>;
}

function EmptySeat({ seat, locked, disabled, onSelect }: { readonly seat: number; readonly locked: boolean; readonly disabled: boolean; readonly onSelect: () => void }) {
  const number = <span className="lobby-empty-number" aria-hidden="true">{seat + 1}</span>;
  // P1 AI seats will extend this single empty-seat entry; P0 renders no AI control.
  if (locked) return <div className="lobby-seat-empty lobby-seat-feedback" data-locked="true">{number}<span className="lobby-empty-label">{message("room.emptySeat")}</span></div>;
  return <button className="lobby-seat-empty lobby-seat-feedback" type="button" disabled={disabled} aria-label={formatMessage("room.selectSeatNumbered", { number: seat + 1 })} onClick={onSelect}>
    {number}<span className="lobby-empty-label" aria-hidden="true">+ {message("room.seatJoin")}</span>
  </button>;
}

function SeatCard({ seat, player, self, host, stack }: { readonly seat: number; readonly player: RoomPlayer; readonly self: boolean; readonly host: boolean; readonly stack: number }) {
  const online = player.connectionStatus === "CONNECTED";
  const status = [online ? null : message("room.disconnectedMember"), player.ready ? null : message("room.notReady")].filter((text) => text !== null).join(" · ");
  return <div className="lobby-seat-card lobby-seat-feedback" data-self={self} data-ready={player.ready} data-online={online}>
    <span className="lobby-seat-no"><span className="sr-only">{message("room.seatPrefix")} </span>{seat + 1}</span>
    <span className="lobby-avatar" aria-hidden="true">{avatarInitial(player.displayName)}<span className="lobby-presence" /></span>
    <span className="lobby-seat-body">
      <span className="lobby-seat-name">
        <span className="lobby-seat-name-text" title={player.displayName}>{player.displayName}</span>
        {self && <span className="lobby-badge lobby-badge-self">{message("table.you")}</span>}
        {host && <span className="lobby-badge lobby-badge-host" title={message("room.host")}><span aria-hidden="true">♛</span><span className="sr-only">{message("room.host")}</span></span>}
      </span>
      <span className="lobby-seat-stack"><span className="lobby-chip-icon" aria-hidden="true" /><span className="sr-only">{message("room.startingStack")} </span>{formatChips(stack)}</span>
      {status !== "" && <span className="lobby-seat-status">{status}</span>}
      {!online && player.ready && <span className="sr-only">{message("room.readyState")}</span>}
    </span>
    {player.ready && <span className="lobby-ready-chip" role="img" aria-label={message("room.readyState")}>
      <span aria-hidden="true">✓</span><span className="lobby-ready-chip-label" aria-hidden="true">{message("room.readyStamp")}</span>
    </span>}
  </div>;
}

function LobbyPlaque({ room, isHost, locked, inviteCode, readiness, onCopy }: { readonly room: RoomSnapshot; readonly isHost: boolean; readonly locked: boolean; readonly inviteCode: string | null; readonly readiness: LobbyReadiness; readonly onCopy: (link: boolean) => void }) {
  const actionTime = room.config.actionTime === "UNLIMITED" ? message("brand.unlimited") : formatMessage("brand.seconds", { value: room.config.actionTime });
  const hint = readiness.canStart ? message(isHost ? "room.allReadyHost" : "room.allReadyMember") : message("room.waitingReady");
  return <section className="lobby-plaque" aria-labelledby="invite-heading">
    <h2 id="invite-heading" className="lobby-plaque-kicker">{message("room.invite")}</h2>
    {inviteCode !== null
      ? <div className="lobby-plaque-invite">
        <p className="rr-invite-code">{inviteCode}</p>
        <div className="lobby-plaque-copy">
          <button className="lobby-copy-button" type="button" onClick={() => onCopy(false)}>{message("room.copyCode")}</button>
          <button className="lobby-copy-button" type="button" onClick={() => onCopy(true)}>{message("room.copyLink")}</button>
        </div>
      </div>
      : <p className="lobby-plaque-paused">{message(locked ? "room.invitePaused" : "room.inviteAvailable")}</p>}
    <dl className="lobby-plaque-summary">
      <div><dt>{message("room.blinds")}</dt><dd>{formatMessage("room.blindsValue", { small: formatChips(room.config.smallBlind), big: formatChips(room.config.bigBlind) })}</dd></div>
      <div><dt>{message("room.startingStack")}</dt><dd>{formatChips(room.config.startingStack)}</dd></div>
      <div><dt>{message("room.actionTime")}</dt><dd>{actionTime}</dd></div>
    </dl>
    {!locked && <p className="lobby-plaque-status" data-ready={readiness.canStart} aria-live="polite">
      <span>{formatMessage("room.readyCount", { ready: readiness.ready, total: readiness.members })}</span>
      <span>{hint}</span>
    </p>}
  </section>;
}
