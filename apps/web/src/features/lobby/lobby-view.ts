import type { RoomSnapshot } from "@texas-holdem/protocol";
import { formatMessage, message } from "../../messages/zh-CN";

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

export function lobbyInviteCode(room: RoomSnapshot): string | null {
  return room.status === "LOBBY" ? room.inviteCode : null;
}
