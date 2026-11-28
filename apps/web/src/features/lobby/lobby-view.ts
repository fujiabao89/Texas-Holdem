import type { RoomSnapshot } from "@texas-holdem/protocol";
import { formatMessage, message } from "../../messages/zh-CN";

type RoomPlayer = RoomSnapshot["players"][number];

/** P0 RoomSnapshot contains human members only; no parallel participant DTO. */
export function lobbyStartBlockers(room: RoomSnapshot): readonly string[] {
  const blockers: string[] = [];
  if (room.status !== "LOBBY" || room.activeTournamentId !== null) blockers.push(message("room.locked"));
  if (room.players.length < 2) blockers.push(message("room.startNeedPlayers"));
  for (const player of room.players) {
    if (player.connectionStatus !== "CONNECTED") blockers.push(formatMessage("room.startOffline", { name: player.displayName }));
    if (player.seat === null) blockers.push(formatMessage("room.startUnseated", { name: player.displayName }));
    if (!player.ready) blockers.push(formatMessage("room.startUnready", { name: player.displayName }));
  }
  return blockers;
}

export type LobbyStartCheckKey = "lobby" | "players" | "online" | "seated" | "ready";

export interface LobbyStartCheck {
  readonly key: LobbyStartCheckKey;
  readonly met: boolean;
  /** Exactly the `lobbyStartBlockers` messages that belong to this condition. */
  readonly reasons: readonly string[];
}

/**
 * TEX-68: the start blockers grouped into a visual checklist. It reads the same
 * snapshot fields and messages as `lobbyStartBlockers`, so the list and the start
 * button can never disagree.
 */
export function lobbyStartChecklist(room: RoomSnapshot): readonly LobbyStartCheck[] {
  const lobbyOpen = room.status === "LOBBY" && room.activeTournamentId === null;
  const reasons = (pick: (player: RoomPlayer) => boolean, key: Parameters<typeof message>[0]) =>
    room.players.filter(pick).map((player) => formatMessage(key, { name: player.displayName }));
  const offline = reasons((player) => player.connectionStatus !== "CONNECTED", "room.startOffline");
  const unseated = reasons((player) => player.seat === null, "room.startUnseated");
  const unready = reasons((player) => !player.ready, "room.startUnready");
  return [
    { key: "lobby", met: lobbyOpen, reasons: lobbyOpen ? [] : [message("room.locked")] },
    { key: "players", met: room.players.length >= 2, reasons: room.players.length >= 2 ? [] : [message("room.startNeedPlayers")] },
    { key: "online", met: offline.length === 0, reasons: offline },
    { key: "seated", met: unseated.length === 0, reasons: unseated },
    { key: "ready", met: unready.length === 0, reasons: unready },
  ];
}

export function lobbyInviteCode(room: RoomSnapshot): string | null {
  return room.status === "LOBBY" ? room.inviteCode : null;
}

/** Physical seats 0…maxPlayers-1, each with its authoritative occupant or null. */
export function lobbySeats(room: RoomSnapshot): readonly (RoomPlayer | null)[] {
  return Array.from({ length: room.config.maxPlayers }, (_, seat) => room.players.find((player) => player.seat === seat) ?? null);
}

export interface LobbyReadiness {
  readonly ready: number;
  readonly members: number;
  readonly canStart: boolean;
}

export function lobbyReadiness(room: RoomSnapshot): LobbyReadiness {
  return {
    ready: room.players.filter((player) => player.ready).length,
    members: room.players.length,
    canStart: lobbyStartBlockers(room).length === 0,
  };
}

/** First visible character of a nickname, safe for surrogate pairs. */
export function avatarInitial(displayName: string): string {
  const first = Array.from(displayName.trim())[0];
  return first === undefined ? "?" : first.toLocaleUpperCase("zh-CN");
}

const chipFormat = new Intl.NumberFormat("zh-CN");

export function formatChips(amount: number): string {
  return chipFormat.format(amount);
}
