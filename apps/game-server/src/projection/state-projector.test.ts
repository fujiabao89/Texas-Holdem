import { describe, expect, it } from "vitest";
import { GameEventSchema, PlayerViewSchema } from "@texas-holdem/protocol";
import {
  SeededRandomSource,
  TournamentEngine,
  type LegalActions,
  type PlayerAction,
} from "@texas-holdem/poker-engine";
import {
  projectPlayerView,
  projectViewPatch,
  projectWireEvent,
  type ProjectionInput,
  type WireProjectionContext,
} from "./state-projector";

const CONFIG = {
  maxPlayers: 10,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed" as const,
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30 as const,
  timeBank: 60 as const,
};

const SEAT_TO_PLAYER = new Map([
  [0, "p0"],
  [1, "p1"],
  [2, "p2"],
]);

it("projects a championless tournament with empty standings as a schema-valid null winner", () => {
  const event = projectWireEvent({ sequence: 0, type: "TOURNAMENT_FINISHED", championSeat: null, finalStandings: [] }, wireContext(makeEngine(), "p0"));
  expect(GameEventSchema.parse(event)).toEqual({ type: "TOURNAMENT_FINISHED", payload: { winnerPlayerId: null, rankings: [] } });
});

function makeEngine(seatCount = 2, seed = 42): TournamentEngine {
  const rng = new SeededRandomSource(seed);
  const participants = Array.from({ length: seatCount }, (_, seatIndex) => ({
    seatIndex,
    name: `Player ${seatIndex}`,
    kind: "human" as const,
  }));
  return new TournamentEngine(CONFIG, rng, participants);
}

function projectionInput(
  engine: TournamentEngine,
  viewer: string,
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    tournamentId: "t1",
    handId: engine.getState().handNumber > 0 ? `h${engine.getState().handNumber}` : null,
    sequence: 0,
    engineState: engine.getState(),
    seatToPlayer: SEAT_TO_PLAYER,
    actionDeadline: null,
    currentLegalActions: null,
    timeBankRemainingMs: new Map([["p0", 60000], ["p1", 60000]]),
    viewerPlayerId: viewer,
    ...overrides,
  };
}

function wireContext(engine: TournamentEngine, viewer: string): WireProjectionContext {
  return {
    seatToPlayer: SEAT_TO_PLAYER,
    viewerPlayerId: viewer,
    blindLevelIndex: engine.getState().blindLevel,
    board: engine.getState().hand?.communityCards ?? [],
  };
}

/** 从 LegalActions 选最简动作推进一手直到结算（Check → Call → All-in → Bet → Raise → Fold 优先）。 */
function playToCompletion(engine: TournamentEngine): void {
  let guard = 0;
  if (!engine.getState().handInProgress && engine.getState().handNumber === 0) {
    engine.startNextHand();
  }
  while (engine.getState().handInProgress && engine.getState().hand?.outcome === null) {
    if (guard++ > 200) throw new Error("test hand did not settle");
    const hand = engine.getState().hand;
    const actor = hand?.currentActor;
    if (hand === null || actor === null || actor === undefined) throw new Error("no actor");
    engine.applyAction(chooseSimple(engine.getLegalActions(), actor));
  }
}

function chooseSimple(current: LegalActions, seatIndex: number): PlayerAction {
  const source = "human_socket";
  if (current.canCheck) return { type: "check", seatIndex, source };
  if (current.canCall) return { type: "call", seatIndex, source };
  if (current.canAllIn) return { type: "all-in", seatIndex, source };
  if (current.canBet && current.minBetTo !== null) {
    return { type: "bet", seatIndex, amount: current.minBetTo, source };
  }
  if (current.canRaise && current.minRaiseTo !== null) {
    return { type: "raise", seatIndex, amount: current.minRaiseTo, source };
  }
  return { type: "fold", seatIndex, source };
}

describe("projectPlayerView", () => {
  it("首手开始时投影 schema 合法且含桌牌与座位数据", () => {
    const engine = makeEngine(3, 42);
    engine.startNextHand();
    const view = projectPlayerView(projectionInput(engine, "p0"));
    expect(PlayerViewSchema.safeParse(view).success).toBe(true);
    expect(view.tournamentStatus).toBe("RUNNING");
    expect(view.handPhase).toBe("PREFLOP");
    expect(view.players).toHaveLength(3);
    expect(view.players.map((p) => p.playerId)).toEqual(["p0", "p1", "p2"]);
    expect(view.players[0]!.stack).toBe(1000);
    expect(view.dealerSeat).toBe(engine.getState().dealerSeat);
    expect(view.viewer.playerId).toBe("p0");
    expect(view.actionDeadline).toBeNull();
  });

  it("接收者只能看到自己的底牌（红线 2：字段级隔离）", () => {
    const engine = makeEngine(2, 42);
    engine.startNextHand();
    const hand = engine.getState().hand!;
    const seatOf = (playerId: string) => [...SEAT_TO_PLAYER].find(([, id]) => id === playerId)![0];
    const p0Cards = hand.seats.find((s) => s.seatIndex === seatOf("p0"))!.holeCards;
    expect(p0Cards.length).toBeGreaterThan(0);

    const viewP0 = projectPlayerView(projectionInput(engine, "p0"));
    expect(viewP0.viewer.holeCards).toEqual(p0Cards.map((c) => ({ rank: rankString(c.rank), suit: c.suit.toUpperCase() })));

    const p1Cards = hand.seats.find((s) => s.seatIndex === seatOf("p1"))!.holeCards;
    const viewP1 = projectPlayerView(projectionInput(engine, "p1"));
    expect(viewP1.viewer.holeCards).toEqual(p1Cards.map((c) => ({ rank: rankString(c.rank), suit: c.suit.toUpperCase() })));
    // 序列化层面不得包含 p0 的底牌（哨兵：p1 视图只有自己的牌面，不含 p0 的两张牌）
    expect(JSON.stringify(viewP1)).not.toContain(JSON.stringify(p0Cards.map((c) => ({ rank: rankString(c.rank), suit: c.suit.toUpperCase() }))));
  });

  it("legalActions 仅当前 actor 非空，且直接采用 Engine 输出", () => {
    const engine = makeEngine(2, 42);
    const legal = engine.startNextHand();
    const actorSeat = engine.getState().hand!.currentActor!;
    const actorId = SEAT_TO_PLAYER.get(actorSeat)!;
    const otherId = SEAT_TO_PLAYER.get(actorSeat === 0 ? 1 : 0)!;
    const viewActor = projectPlayerView(
      projectionInput(engine, actorId, { currentLegalActions: legal, actionDeadline: 1000 }),
    );
    expect(viewActor.viewer.legalActions).not.toBeNull();
    expect(viewActor.currentActorPlayerId).toBe(actorId);
    const viewOther = projectPlayerView(projectionInput(engine, otherId, { currentLegalActions: legal }));
    expect(viewOther.viewer.legalActions).toBeNull();
  });

  it("Showdown 后非弃牌玩家的底牌进入 revealedCards", () => {
    const engine = makeEngine(2, 42);
    playToCompletion(engine);
    const outcome = engine.getState().hand!.outcome!;
    expect(outcome.showdown).toBe(true);
    const view = projectPlayerView(projectionInput(engine, "p0"));
    const p0 = view.players.find((p) => p.playerId === "p0")!;
    const p1 = view.players.find((p) => p.playerId === "p1")!;
    // 2 人无弃牌 Showdown：双方都亮牌
    expect(p0.revealedCards.length).toBe(2);
    expect(p1.revealedCards.length).toBe(2);
    expect(view.handPhase).toBe("HAND_END");
  });

  it("pots：进行中投影单一底池；结算后按 Pot 分层", () => {
    const engine = makeEngine(2, 42);
    engine.startNextHand();
    const during = projectPlayerView(projectionInput(engine, "p0"));
    expect(during.pots.length).toBe(1);
    expect(during.pots[0]!.amount).toBeGreaterThanOrEqual(15);

    playToCompletion(engine);
    const after = projectPlayerView(projectionInput(engine, "p0"));
    expect(after.pots.length).toBeGreaterThanOrEqual(1);
  });
});

describe("projectViewPatch（apply 不变量）", () => {
  it("patch 应用于先前视图逐字段等于当前投影", () => {
    const engine = makeEngine(2, 42);
    engine.startNextHand();
    const before = projectPlayerView(projectionInput(engine, "p0", { sequence: 0 }));
    engine.applyAction({
      type: "call",
      seatIndex: engine.getState().hand!.currentActor!,
      source: "human_socket",
    });
    const patch = projectViewPatch(projectionInput(engine, "p0", { sequence: 1 }));
    const after = projectPlayerView(projectionInput(engine, "p0", { sequence: 1 }));
    expect(applyPatch(before, patch)).toEqual(after);
  });
});

describe("projectWireEvent", () => {
  it("DEAL_HOLE_CARD 的 card 只投影给目标玩家", () => {
    const engine = makeEngine(2, 42);
    engine.startNextHand();
    const dealEvent = engine
      .getEvents()
      .find((e): e is Extract<typeof e, { type: "DEAL_HOLE_CARD" }> => e.type === "DEAL_HOLE_CARD");
    if (dealEvent === undefined) throw new Error("no deal event");
    const targetId = SEAT_TO_PLAYER.get(dealEvent.seatIndex)!;
    const otherId = SEAT_TO_PLAYER.get(dealEvent.seatIndex === 0 ? 1 : 0)!;
    const forTarget = projectWireEvent(dealEvent, wireContext(engine, targetId));
    expect(forTarget.type).toBe("DEAL_HOLE_CARD");
    if (forTarget.type === "DEAL_HOLE_CARD") expect(forTarget.payload.card).toBeDefined();
    const forOther = projectWireEvent(dealEvent, wireContext(engine, otherId));
    expect(forOther.type).toBe("DEAL_HOLE_CARD");
    if (forOther.type === "DEAL_HOLE_CARD") expect(forOther.payload.card).toBeUndefined();
  });

  it("BURN_CARD 永不携带牌面", () => {
    const engine = makeEngine(2, 42);
    playToCompletion(engine);
    const burn = engine
      .getEvents()
      .find((e): e is Extract<typeof e, { type: "BURN_CARD" }> => e.type === "BURN_CARD");
    expect(burn).toBeDefined();
    const wire = projectWireEvent(burn!, wireContext(engine, "p0"));
    expect(wire.type).toBe("BURN_CARD");
    expect(JSON.stringify(wire.payload)).not.toContain("card");
  });

  it("PLAYER_REVEALED 只公开服务端 evaluator 给出的最佳五张牌", () => {
    const engine = makeEngine(2, 42);
    playToCompletion(engine);
    const revealed = engine.getEvents().find((event): event is Extract<typeof event, { type: "PLAYER_REVEALED" }> => event.type === "PLAYER_REVEALED");
    if (revealed === undefined) throw new Error("no showdown reveal");
    const wire = projectWireEvent(revealed, wireContext(engine, "p0"));
    expect(wire.type).toBe("PLAYER_REVEALED");
    if (wire.type === "PLAYER_REVEALED") {
      expect(wire.payload.handRank.bestFiveCards).toHaveLength(5);
      const publicCards = [...revealed.cards, ...wireContext(engine, "p0").board].map((card) => `${rankString(card.rank)}:${card.suit.toUpperCase()}`);
      expect(wire.payload.handRank.bestFiveCards.every((card) => publicCards.includes(`${card.rank}:${card.suit}`))).toBe(true);
    }
  });

  it("PLAYER_RAISED 恒为完整加注（isFullRaise=true）", () => {
    const engine = makeEngine(2, 42);
    engine.startNextHand();
    // 首行动者（SB）面对 BB 可完整加注：提交 minRaiseTo 触发 PLAYER_RAISED
    const firstActor = engine.getState().hand!.currentActor!;
    const legal = engine.getLegalActions();
    expect(legal.canRaise).toBe(true);
    engine.applyAction({ type: "raise", seatIndex: firstActor, amount: legal.minRaiseTo!, source: "human_socket" });
    const raised = engine.getEvents().find((e) => e.type === "PLAYER_RAISED");
    expect(raised).toBeDefined();
    const wire = projectWireEvent(raised!, wireContext(engine, "p0"));
    expect(wire.type).toBe("PLAYER_RAISED");
    if (wire.type === "PLAYER_RAISED") {
      expect(wire.payload.isFullRaise).toBe(true);
      expect(wire.payload.raiseTo).toBeGreaterThan(0);
    }
  });
});

function rankString(rank: number): string {
  return rank === 14 ? "A" : rank === 13 ? "K" : rank === 12 ? "Q" : rank === 11 ? "J" : rank === 10 ? "10" : String(rank);
}

/** 简单逐字段应用 patch（协议客户端语义：字段缺失表示不变）。 */
function applyPatch(
  previous: ReturnType<typeof projectPlayerView>,
  patch: ReturnType<typeof projectViewPatch>,
): ReturnType<typeof projectPlayerView> {
  return {
    handId: patch.handId !== undefined ? patch.handId : previous.handId,
    tournamentStatus: patch.tournamentStatus ?? previous.tournamentStatus,
    handPhase: patch.handPhase !== undefined ? patch.handPhase : previous.handPhase,
    blindLevel: patch.blindLevel ?? previous.blindLevel,
    dealerSeat: patch.dealerSeat !== undefined ? patch.dealerSeat : previous.dealerSeat,
    board: patch.board ?? previous.board,
    pots: patch.pots ?? previous.pots,
    currentActorPlayerId: patch.currentActorPlayerId !== undefined ? patch.currentActorPlayerId : previous.currentActorPlayerId,
    actionDeadline: patch.actionDeadline !== undefined ? patch.actionDeadline : previous.actionDeadline,
    players: (patch.players ?? previous.players) as ReturnType<typeof projectPlayerView>["players"],
    viewer: { ...previous.viewer, ...patch.viewer } as ReturnType<typeof projectPlayerView>["viewer"],
    rankings: patch.rankings ?? previous.rankings,
  };
}
