/**
 * buildHandCommitBundle 结果更新回归（TEX-28 P1：同手多淘汰 rank 唯一性）。
 *
 * 引擎 §12 对同手淘汰组共享 placementRange 并以 displayOrder 打破并列；docs/03
 * §5.4 要求 tournament_players.rank 为唯一精确名次（部分唯一索引）。历史缺陷：
 * 直接写 placementRange.from 使同手多淘汰在终局 Bundle 内撞唯一索引 23505，
 * 整包回滚且 Writer 判为完整性错误 → 内存/DB 分裂 + watermark 降级（F-4）。
 */
import { describe, expect, it } from "vitest";

import { buildHandCommitBundle } from "./tournament-persistence";
import type { TournamentRuntimeState } from "./tournament-runtime";
import type { PokerEvent, TournamentState } from "@texas-holdem/poker-engine";

function buildContext(): Parameters<typeof buildHandCommitBundle>[0] {
  const playerIds = ["p-1", "p-2", "p-3"];
  const state = {
    tournamentId: "t-1",
    currentHandId: "hand-2",
    committedEventCount: 41,
    ids: { uuid: () => "snap-id" },
    players: new Map(
      playerIds.map((playerId, index) => [
        playerId,
        {
          playerId,
          tournamentPlayerId: `tp-${index + 1}`,
          seatIndex: index,
          kind: "HUMAN" as const,
          displayName: `玩家${index + 1}`,
          connected: true,
          graceHandle: null,
          graceGeneration: 0,
          timeBank: { secondsRemaining: 60, usedThisOpportunity: false },
        },
      ]),
    ),
    seatToPlayer: new Map([
      [0, "p-1"],
      [1, "p-2"],
      [2, "p-3"],
    ]),
  } as unknown as TournamentRuntimeState;
  const engineState = {
    blindLevel: 0,
    phase: "finished",
    champion: 0,
    participants: [{ seatIndex: 0, chips: 60 }],
    hand: {
      handNumber: 2,
      dealerSeat: 0,
      sbSeat: 1,
      bbSeat: 2,
      smallBlind: 1,
      bigBlind: 2,
      communityCards: [],
      outcome: { showdown: true, pots: [], awards: [], winners: [] },
    },
  } as unknown as TournamentState;
  const events = [
    { type: "PLAYER_ELIMINATED", handNumber: 2, seatIndex: 1, placementRange: { from: 2, to: 3 }, displayOrder: 1 },
    { type: "PLAYER_ELIMINATED", handNumber: 2, seatIndex: 2, placementRange: { from: 2, to: 3 }, displayOrder: 2 },
    { type: "TOURNAMENT_FINISHED", championSeat: 0, finalStandings: [] },
  ] as unknown as PokerEvent[];
  return {
    state,
    engineState,
    handStartedAt: 1_000,
    handEndedAt: 2_000,
    events,
  };
}

describe("buildHandCommitBundle: 同手多淘汰结果更新", () => {
  it("组内按 displayOrder 分配唯一 rank（from + displayOrder - 1），不再共享 from 撞唯一索引", () => {
    const bundle = buildHandCommitBundle(buildContext(), {
      status: "FINISHED",
      championTournamentPlayerId: "tp-1",
      finishedAt: new Date(2_000),
      retentionExpiresAt: new Date(3_000),
      roomStatus: "FINISHED",
    });

    const eliminated = bundle.playerUpdates.filter((u) => u.pokerStatus === "ELIMINATED");
    expect(eliminated).toHaveLength(2);
    // 并列打破：displayOrder=1（手开始筹码多者）名次最好（from），displayOrder=2 → from+1。
    expect(eliminated.map((u) => u.rank).sort((a, b) => a! - b!)).toEqual([2, 3]);
    // rank 在 bundle 内唯一（docs/03 §5.4 部分唯一索引 tournament_players_tournament_rank_unique）。
    expect(new Set(bundle.playerUpdates.map((u) => u.rank)).size).toBe(bundle.playerUpdates.filter((u) => u.rank !== null).length);
    // 冠军 rank=1。
    const champion = bundle.playerUpdates.find((u) => u.tournamentPlayerId === "tp-1");
    expect(champion?.rank).toBe(1);
    // 两个淘汰者 eliminatedHandId 指向本手。
    for (const update of eliminated) expect(update.eliminatedHandId).toBe("hand-2");
  });

  it("序列咬合：首事件 = 水位 + 1，handSequence 从 1 连续，snapshot.sequence = 末事件 sequence", () => {
    const bundle = buildHandCommitBundle(buildContext());
    expect(bundle.events[0]?.sequence).toBe(42n);
    expect(bundle.events.map((e) => e.handSequence)).toEqual([1, 2, 3]);
    expect(bundle.snapshot.sequence).toBe(44n);
  });
});
