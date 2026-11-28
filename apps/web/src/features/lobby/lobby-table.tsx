"use client";

import type { CSSProperties, ReactNode } from "react";
import type { RoomSnapshot } from "@texas-holdem/protocol";

import { formatMessage, message } from "../../messages/zh-CN";
import { primaryButton } from "./room-flows";
import {
  isCompactDesktopTable,
  lobbySeatLayout,
  mobileFeltHeight,
  type LobbySeatPlacement,
} from "./lobby-seat-layout";
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

/** TEX-68: interactive physical lobby table aligned with the approved zero-overlap demo. */
export function LobbyTable(props: LobbyTableProps) {
  const { room, self, seats, isHost, locked, disabled, inviteCode, readiness, feedback } = props;
  const wide = lobbySeatLayout(room.config.maxPlayers, "landscape");
  const tall = lobbySeatLayout(room.config.maxPlayers, "portrait");
  const compact = isCompactDesktopTable(room.config.maxPlayers);
  const emptySeat = seats.findIndex((player) => player === null);
  const actionTime = room.config.actionTime === "UNLIMITED"
    ? message("brand.unlimited")
    : formatMessage("brand.seconds", { value: room.config.actionTime });
  const stageStyle = {
    "--mobile-felt-h": `${mobileFeltHeight(room.config.maxPlayers)}px`,
  } as CSSProperties;

  return <section className="lobby-stage" data-compact={compact} style={stageStyle} aria-labelledby="seats-heading">
    <h2 id="seats-heading" className="sr-only">{message("room.seats")}</h2>
    <div className="lobby-stage-card">
      <div className="lobby-table-wrap">
        <LobbyPlaque
          room={room}
          actionTime={actionTime}
          isHost={isHost}
          locked={locked}
          inviteCode={inviteCode}
          readiness={readiness}
          onCopy={props.onCopy}
        />
        <div className="lobby-felt-frame">
          <div className="lobby-felt-area">
            <div className="lobby-felt" aria-hidden="true">
              <span className="lobby-felt-stitch" />
            </div>
            <div className="lobby-felt-watermark" aria-hidden="true">
              <span className="lobby-wm-suit">♠</span>
              <span className="lobby-wm-blinds">{formatMessage("room.blindsValue", { small: formatChips(room.config.smallBlind), big: formatChips(room.config.bigBlind) })}</span>
              <span className="lobby-wm-stack">{formatMessage("room.watermarkStack", { stack: formatChips(room.config.startingStack) })}</span>
              <span className="lobby-wm-time">{actionTime}</span>
            </div>
            <ol className="lobby-seats">
              {seats.map((player, seat) => <SeatSlot key={seat} seat={seat} wide={wide[seat]} tall={tall[seat]}>
                {player === null
                  ? <EmptySeat seat={seat} compact={compact} locked={locked} disabled={disabled} onSelect={() => props.onSelectSeat(seat)} />
                  : <SeatCard
                      key={`${player.playerId}:${player.ready}`}
                      player={player}
                      self={player.playerId === self.playerId}
                      host={player.playerId === room.hostPlayerId}
                      stack={room.config.startingStack}
                      compact={compact}
                    />}
              </SeatSlot>)}
            </ol>
          </div>
        </div>
      </div>

      {!locked && <div className="lobby-dock" role="group" aria-label={message("room.dockLabel")}>
        <div className="lobby-dock-secondary">
          <button className="lobby-btn-outline" type="button" disabled={disabled || emptySeat === -1} onClick={() => props.onSelectSeat(emptySeat)}>{message("room.randomSeat")}</button>
          {self.seat !== null && <button className="lobby-btn-outline" type="button" disabled={disabled} onClick={() => props.onSelectSeat(null)}>{message("room.leaveSeat")}</button>}
        </div>
        <div className="lobby-dock-primary">
          <button className="lobby-ready-button" type="button" data-ready={self.ready} disabled={disabled || self.seat === null} onClick={props.onToggleReady}>
            {self.ready ? message("room.unready") : message("room.ready")}
          </button>
          {isHost && <button className={`${primaryButton} lobby-start-button`} type="button" disabled={!readiness.canStart || disabled} onClick={props.onStart}>{message("room.start")}</button>}
        </div>
      </div>}
    </div>
    {feedback}
  </section>;
}

function SeatSlot({ seat, wide, tall, children }: { readonly seat: number; readonly wide: LobbySeatPlacement | undefined; readonly tall: LobbySeatPlacement | undefined; readonly children: ReactNode }) {
  const style = {
    "--lx": `${wide?.x ?? 50}%`,
    "--ly": `${wide?.y ?? 50}%`,
    "--ltx": `${(wide?.tx ?? -0.5) * 100}%`,
    "--lty": `${(wide?.ty ?? -0.5) * 100}%`,
    "--px": `${tall?.x ?? 50}%`,
    "--py": `${tall?.y ?? 50}%`,
    "--ptx": `${(tall?.tx ?? -0.5) * 100}%`,
    "--pty": `${(tall?.ty ?? -0.5) * 100}%`,
  } as CSSProperties;
  return <li
    className="lobby-seat-slot"
    data-lobby-seat={seat}
    data-chip-dir={wide?.chipDir ?? "top"}
    data-mchip-dir={tall?.chipDir ?? "top"}
    style={style}
  >{children}</li>;
}

function EmptySeat({ seat, compact, locked, disabled, onSelect }: { readonly seat: number; readonly compact: boolean; readonly locked: boolean; readonly disabled: boolean; readonly onSelect: () => void }) {
  const number = <span className="lobby-empty-number" aria-hidden="true">{seat + 1}</span>;
  // P1 AI seats will extend this empty-seat entry; P0 renders no AI controls.
  if (locked) {
    return <div className="lobby-seat-empty lobby-seat-feedback" data-locked="true" data-compact={compact}>
      {number}
      <span className="lobby-empty-copy"><span className="lobby-empty-label">{message("room.emptySeat")}</span></span>
    </div>;
  }
  return <button
    className="lobby-seat-empty lobby-seat-feedback"
    data-compact={compact}
    type="button"
    disabled={disabled}
    aria-label={formatMessage("room.selectSeatNumbered", { number: seat + 1 })}
    onClick={onSelect}
  >
    {number}
    <span className="lobby-empty-copy" aria-hidden="true">
      <span className="lobby-empty-label">+ {message("room.seatJoin")}</span>
      {!compact && <span className="lobby-empty-sub">{message("room.emptySeat")}</span>}
    </span>
  </button>;
}

function SeatCard({ player, self, host, stack, compact }: { readonly player: RoomPlayer; readonly self: boolean; readonly host: boolean; readonly stack: number; readonly compact: boolean }) {
  const online = player.connectionStatus === "CONNECTED";
  const unreadyText = online ? message("room.notReady") : `${message("room.disconnectedMember")} · ${message("room.notReady")}`;
  return <div className="lobby-seat-card lobby-seat-feedback" data-self={self} data-ready={player.ready} data-online={online} data-compact={compact}>
    <span className="lobby-avatar" aria-hidden="true">
      {avatarInitial(player.displayName)}
      <span className="lobby-presence" />
    </span>
    <span className="lobby-seat-body">
      <span className="lobby-seat-name">
        <span className="lobby-seat-name-text" title={player.displayName}>{player.displayName}</span>
        {host && <span className="lobby-badge lobby-badge-host" title={message("room.host")}>{message("room.host")}</span>}
        {self && <span className="lobby-badge lobby-badge-self">{message("table.you")}</span>}
      </span>
      <span className="lobby-seat-stack">
        <span className="lobby-chip-icon" aria-hidden="true" />
        <span className="sr-only">{message("room.startingStack")} </span>
        <span>{formatChips(stack)}</span>
      </span>
    </span>
    {!player.ready && <span className="lobby-seat-pending-tag">{unreadyText}</span>}
    {player.ready && !online && <span className="lobby-seat-pending-tag">{message("room.disconnectedMember")}</span>}
    {player.ready && <span className="lobby-ready-chip" role="img" aria-label={message("room.readyState")}>
      <span aria-hidden="true">✓</span>
      <span className="lobby-ready-chip-label" aria-hidden="true">{message("room.readyStamp")}</span>
    </span>}
  </div>;
}

function LobbyPlaque({ room, actionTime, isHost, locked, inviteCode, readiness, onCopy }: {
  readonly room: RoomSnapshot;
  readonly actionTime: string;
  readonly isHost: boolean;
  readonly locked: boolean;
  readonly inviteCode: string | null;
  readonly readiness: LobbyReadiness;
  readonly onCopy: (link: boolean) => void;
}) {
  const statusText = readiness.canStart
    ? message(isHost ? "room.allReadyHost" : "room.allReadyMember")
    : `${formatMessage("room.readyCount", { ready: readiness.ready, total: readiness.members })} · ${message("room.waitingReady")}`;

  return <section className="lobby-plaque" aria-labelledby="invite-heading">
    <div className="lobby-plaque-card">
      <div className="lobby-plaque-main">
        <div className="lobby-plaque-code-group">
          <h2 id="invite-heading" className="lobby-plaque-kicker">{message("room.inviteCodeKicker")}</h2>
          {inviteCode !== null
            ? <p className="rr-invite-code">{inviteCode}</p>
            : <p className="lobby-plaque-paused">{message(locked ? "room.invitePaused" : "room.inviteAvailable")}</p>}
        </div>
        {inviteCode !== null && <div className="lobby-plaque-copy">
          <button className="lobby-copy-button" type="button" onClick={() => onCopy(false)}>{message("room.copyCode")}</button>
          <button className="lobby-copy-button lobby-copy-link" type="button" onClick={() => onCopy(true)}>{message("room.copyLink")}</button>
        </div>}
      </div>
      <p className="lobby-plaque-meta">
        {formatMessage("room.plaqueMeta", {
          small: formatChips(room.config.smallBlind),
          big: formatChips(room.config.bigBlind),
          stack: formatChips(room.config.startingStack),
          time: actionTime,
        })}
      </p>
    </div>
    {!locked && <p className="lobby-plaque-status" data-ready={readiness.canStart} aria-live="polite">{statusText}</p>}
  </section>;
}
