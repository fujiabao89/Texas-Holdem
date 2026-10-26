import { describe, expect, it } from "vitest";
import { roomSnapshot } from "../../testing-fixtures";
import { lobbyInviteCode, lobbyStartBlockers } from "./lobby-view";

describe("next-round lobby presentation", () => {
  const readyRoom = roomSnapshot({ status: "LOBBY", activeTournamentId: null });
  it("permits two connected, seated, ready humans only in an inactive lobby", () => {
    expect(lobbyStartBlockers(readyRoom)).toEqual([]);
    for (const status of ["IN_GAME", "FINISHED", "CLOSED"] as const) expect(lobbyStartBlockers({ ...readyRoom, status }).length).toBeGreaterThan(0);
    expect(lobbyStartBlockers({ ...readyRoom, activeTournamentId: "other" }).length).toBeGreaterThan(0);
    expect(lobbyStartBlockers({ ...readyRoom, players: readyRoom.players.slice(0, 1) })).toContain("至少需要两位已入座且准备完成的玩家。");
  });
  it("names every offline, unseated, and unready member, even when others are ready", () => {
    const room = { ...readyRoom, players: readyRoom.players.map((p, i) => i === 1 ? { ...p, connectionStatus: "DISCONNECTED" as const, seat: null, ready: false } : p) };
    expect(lobbyStartBlockers(room)).toEqual(["玩家乙 已离线，请等待重连或由房主移出房间。", "玩家乙 尚未入座。", "玩家乙 尚未准备。"]);
    expect(lobbyStartBlockers({ ...room, players: readyRoom.players })).toEqual([]);
  });
  it("a newly joined member blocks start, and reopening exposes the server reset of all Ready flags", () => {
    expect(lobbyStartBlockers({ ...readyRoom, players: [...readyRoom.players, { ...readyRoom.players[0]!, playerId: "new", displayName: "新玩家", seat: null, ready: false }] })).toEqual(["新玩家 尚未入座。", "新玩家 尚未准备。"]);
    expect(lobbyStartBlockers({ ...readyRoom, players: readyRoom.players.map(p => ({ ...p, ready: false })) })).toHaveLength(2);
  });
  it("only exposes invitations in LOBBY, even if an old local value still exists", () => {
    expect(lobbyInviteCode(readyRoom)).toBe("ABC234");
    for (const status of ["IN_GAME", "FINISHED", "CLOSED"] as const) expect(lobbyInviteCode({ ...readyRoom, status })).toBeNull();
  });
});
