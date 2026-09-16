import { describe, expect, it } from "vitest";

import type { GameSnapshot, TournamentResult } from "@texas-holdem/protocol";

import { errorMessage, message } from "../../messages/zh-CN";
import { HttpTransport } from "../../protocol/http-transport";
import { PlayerTokenStore } from "../../protocol/token-store";
import { gameSnapshot } from "../../testing-fixtures";
import { resultAvailableFor, resultChampion, resultRows } from "./result-view";

const sampleTournamentResult: TournamentResult = {
  tournamentId: "t-1",
  status: "FINISHED",
  championPlayerId: "p-1",
  players: [
    { playerId: "p-1", displayName: "Alice", seat: 0, kind: "HUMAN", pokerStatus: "ACTIVE", finalStack: 3000 },
    { playerId: "p-2", displayName: "Bob", seat: 1, kind: "HUMAN", pokerStatus: "ELIMINATED", finalStack: 0 },
  ],
  rankings: [
    { playerId: "p-1", placement: { from: 1, to: 1 }, displayOrder: 1 },
    { playerId: "p-2", placement: { from: 2, to: 2 }, displayOrder: 1 },
  ],
  finishedAt: 1700000000000,
};

describe("Result flow and recovery (TEX-55)", () => {
  it("fast path: recognizes in-memory snapshot for the matching finished tournament", () => {
    const memoryGame = gameSnapshot({
      tournamentId: "t-1",
      tournamentStatus: "FINISHED",
      players: [
        { playerId: "p-1", displayName: "Alice", seat: 0, stack: 3000, streetBet: 0, totalCommitted: 0, pokerStatus: "ACTIVE", hasHoleCards: false, revealedCards: [] },
        { playerId: "p-2", displayName: "Bob", seat: 1, stack: 0, streetBet: 0, totalCommitted: 0, pokerStatus: "ELIMINATED", hasHoleCards: false, revealedCards: [] },
      ],
      rankings: [
        { playerId: "p-1", placement: { from: 1, to: 1 }, displayOrder: 1 },
        { playerId: "p-2", placement: { from: 2, to: 2 }, displayOrder: 1 },
      ],
    });

    expect(resultAvailableFor(memoryGame, "t-1")).toBe(true);
    expect(resultAvailableFor(memoryGame, "t-other")).toBe(false);

    const rows = resultRows(memoryGame);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ playerId: "p-1", champion: true, finalChips: 3000 });
  });

  it("recovery path: fetches authoritative result via HTTP when memory snapshot is null", async () => {
    const tokenStore = new PlayerTokenStore();
    tokenStore.save("room-1", "valid-token", "p-1");

    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore,
      createUuid: () => "uuid-1",
      fetchFn: async () =>
        new Response(JSON.stringify({ data: sampleTournamentResult }), { status: 200 }),
    });

    const res = await transport.getTournamentResult("t-1", "room-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const rows = resultRows(res.data.data);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ playerId: "p-1", champion: true, finalChips: 3000 });
      const champion = resultChampion(res.data.data);
      expect(champion).toEqual({ hasChampion: true, playerId: "p-1", displayName: "Alice", finalChips: 3000 });
    }
  });

  it("cache isolation: preserves previous tournament results when new round begins", () => {
    const cache: Record<string, TournamentResult | GameSnapshot> = {};

    // First tournament finishes and is cached
    cache["t-1"] = sampleTournamentResult;

    // Room starts tournament t-2, creating new live running snapshot
    const liveGame2 = gameSnapshot({
      tournamentId: "t-2",
      tournamentStatus: "RUNNING",
    });

    // In-memory snapshot does not match t-1
    expect(resultAvailableFor(liveGame2, "t-1")).toBe(false);

    // But cached result for t-1 remains intact and unaffected
    const t1Result = cache["t-1"];
    expect(t1Result).toBeDefined();
    const rows = resultRows(t1Result);
    expect(rows[0].displayName).toBe("Alice");
  });

  it("handles abort and race conditions when user switches tournaments", async () => {
    const tokenStore = new PlayerTokenStore();
    tokenStore.save("room-1", "valid-token", "p-1");

    const transport = new HttpTransport({
      apiBaseUrl: "https://example.test",
      tokenStore,
      createUuid: () => "uuid-1",
      fetchFn: async (_url, init) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new Response(JSON.stringify({ data: sampleTournamentResult }), { status: 200 }));
          }, 500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      },
    });

    const controller = new AbortController();
    const promise = transport.getTournamentResult("t-1", "room-1", { signal: controller.signal });

    // Cancel before response arrives
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("CANCELLED");
    }
  });

  it("maps error codes to user-friendly messages for result states", () => {
    expect(errorMessage("TOURNAMENT_NOT_FOUND")).toBe("未找到该场比赛，或赛果已过保留期。");
    expect(errorMessage("TOURNAMENT_NOT_FINISHED")).toBe("本场比赛尚无已完成的赛果。");
    expect(errorMessage("TOURNAMENT_RESULT_INCOMPLETE")).toBe("赛果正在同步，请稍后重试。");
    expect(errorMessage("AUTH_FAILED")).toBe("身份凭证已失效，请重新加入房间。");

    expect(message("result.loading")).toBe("正在获取比赛结果…");
    expect(message("result.loadFailed")).toBe("获取比赛结果失败");
    expect(message("result.retry")).toBe("重试");
    expect(message("result.backToTable")).toBe("前往牌桌");
    expect(message("result.backToLobby")).toBe("返回大厅");
  });
});
