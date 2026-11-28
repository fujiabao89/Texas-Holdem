import { describe, expect, it } from "vitest";
import { roomSnapshot } from "../../testing-fixtures";
import { avatarInitial, formatChips, lobbyInviteCode, lobbyReadiness, lobbySeats, lobbyStartBlockers, lobbyStartChecklist } from "./lobby-view";

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
    expect(lobbyStartBlockers({ ...readyRoom, players: readyRoom.players.map((p) => ({ ...p, ready: false })) })).toHaveLength(2);
  });
  it("only exposes invitations in LOBBY, even if an old local value still exists", () => {
    expect(lobbyInviteCode(readyRoom)).toBe("ABC234");
    for (const status of ["IN_GAME", "FINISHED", "CLOSED"] as const) expect(lobbyInviteCode({ ...readyRoom, status })).toBeNull();
  });
  it("groups start blockers into a consistent visual checklist and readiness summary", () => {
    expect(lobbyStartChecklist(readyRoom).every((item) => item.met && item.reasons.length === 0)).toBe(true);
    expect(lobbyReadiness(readyRoom)).toEqual({ ready: 2, members: 2, canStart: true });

    const blockedRoom = {
      ...readyRoom,
      players: [
        readyRoom.players[0]!,
        { ...readyRoom.players[1]!, connectionStatus: "DISCONNECTED" as const, seat: null, ready: false },
      ],
    };
    const checklist = lobbyStartChecklist(blockedRoom);
    expect(checklist.map((item) => [item.key, item.met])).toEqual([
      ["lobby", true],
      ["players", true],
      ["online", false],
      ["seated", false],
      ["ready", false],
    ]);
    expect(checklist.flatMap((item) => item.reasons)).toEqual(lobbyStartBlockers(blockedRoom));
    expect(lobbyReadiness(blockedRoom)).toEqual({ ready: 1, members: 2, canStart: false });
  });
  it("maps physical seats, avatar initials, and formatted chip stacks", () => {
    const sixMax = { ...readyRoom, config: { ...readyRoom.config, maxPlayers: 6 } };
    const seats = lobbySeats(sixMax);
    expect(seats).toHaveLength(6);
    expect(seats[0]?.playerId).toBe("player-1");
    expect(seats[1]?.playerId).toBe("player-2");
    expect(seats.slice(2)).toEqual([null, null, null, null]);
    expect(avatarInitial("  alice")).toBe("A");
    expect(avatarInitial("玩家甲")).toBe("玩");
    expect(avatarInitial("   ")).toBe("?");
    expect(formatChips(10_000)).toBe("10,000");
  });
});
