import { describe, expect, it } from "vitest";
import { TournamentResultResponseSchema, type TournamentResultResponse } from "./index";

function result(): TournamentResultResponse {
  return { data: {
    tournamentId: "tournament_1", status: "FINISHED", championPlayerId: "alice", finishedAt: 1760000000000,
    players: [
      { playerId: "alice", displayName: "Alice", seat: 0, kind: "HUMAN", pokerStatus: "ACTIVE", finalStack: 4000 },
      { playerId: "bob", displayName: "Bobby", seat: 1, kind: "HUMAN", pokerStatus: "ELIMINATED", finalStack: 0 },
      { playerId: "carol", displayName: "Carol", seat: 2, kind: "BOT", pokerStatus: "ELIMINATED", finalStack: 0 },
      { playerId: "dan", displayName: "Danny", seat: 3, kind: "HUMAN", pokerStatus: "WITHDRAWN", finalStack: 0 },
    ],
    rankings: [
      { playerId: "alice", placement: { from: 1, to: 1 }, displayOrder: 1 },
      { playerId: "bob", placement: { from: 2, to: 3 }, displayOrder: 1 },
      { playerId: "carol", placement: { from: 2, to: 3 }, displayOrder: 2 },
    ],
  } };
}

describe("TEX-54 strict durable tournament result contract", () => {
  it("accepts a champion, ties, bot participants and unranked withdrawal", () => {
    expect(TournamentResultResponseSchema.parse(result())).toEqual(result());
  });
  it("accepts lawful championless terminal state without inventing a winner", () => {
    const value = result();
    value.data.championPlayerId = null;
    value.data.players[0].pokerStatus = "WITHDRAWN";
    value.data.players[0].finalStack = 0;
    value.data.rankings.shift();
    expect(TournamentResultResponseSchema.safeParse(value).success).toBe(true);
  });
  it.each(["envelope", "result", "player", "ranking", "placement"])("rejects private fields at every %s level", (level) => {
    const value = result();
    const objects = { envelope: value, result: value.data, player: value.data.players[0], ranking: value.data.rankings[0], placement: value.data.rankings[0].placement };
    Object.assign(objects[level as keyof typeof objects], { token: "private", deck: [] });
    expect(TournamentResultResponseSchema.safeParse(value).success).toBe(false);
  });
  it.each(["missing-player", "duplicate-player", "duplicate-seat", "duplicate-ranking", "missing-ranking", "invalid-range", "incomplete-tie", "order", "ranked-withdrawal", "wrong-champion", "missing-champion", "chips", "unsafe-chips", "not-finished"])("rejects semantically invalid %s", (damage) => {
    const value = result();
    if (damage === "missing-player") value.data.rankings[0].playerId = "unknown";
    if (damage === "duplicate-player") value.data.players[1].playerId = "alice";
    if (damage === "duplicate-seat") value.data.players[1].seat = 0;
    if (damage === "duplicate-ranking") value.data.rankings.push(value.data.rankings[0]);
    if (damage === "missing-ranking") value.data.rankings.shift();
    if (damage === "invalid-range") value.data.rankings[1].placement = { from: 3, to: 2 };
    if (damage === "incomplete-tie") value.data.rankings.pop();
    if (damage === "order") value.data.rankings[2].displayOrder = 1;
    if (damage === "ranked-withdrawal") value.data.rankings.push({ playerId: "dan", placement: { from: 4, to: 4 }, displayOrder: 1 });
    if (damage === "wrong-champion") value.data.championPlayerId = "bob";
    if (damage === "missing-champion") value.data.championPlayerId = null;
    if (damage === "chips") value.data.players[1].finalStack = 1;
    if (damage === "unsafe-chips") value.data.players[0].finalStack = Number.MAX_SAFE_INTEGER + 1;
    if (damage === "not-finished") Object.assign(value.data, { status: "RUNNING" });
    expect(TournamentResultResponseSchema.safeParse(value).success).toBe(false);
  });
});
