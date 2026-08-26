import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  HandHistoryDetailResponseSchema,
  HandHistoryListResponseSchema,
} from "@texas-holdem/protocol";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { generateInviteCode, qualifiedTableName, randomUUID, setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";
import { normalizeDisplayNameKey } from "../../src/infrastructure/persistence/display-name";
import { computePlayerTokenDigest, sha256Checksum } from "../../src/infrastructure/persistence";
import {
  createHandCommitRepository,
  createHandHistoryRepository,
  createRoomRepository,
  createTournamentRepository,
  type HandCommitBundle,
  type HandCommitEvent,
} from "../../src/infrastructure/persistence/repositories";
import { registerHandHistoryRoutes } from "../../src/http/routes/hand-history";

/**
 * Hand History 投影读取端点（TEX-36；docs/02 §4.2，docs/03 §6）：
 * 数据库侧 token 鉴权、handNumber DESC cursor 分页、接收者视角隐私隔离
 * （Burn 牌面/他人底牌永不出 wire）、404/无权限/损坏记录降级。
 * 读取走真实持久化路径（hands/hand_events/tournaments/tournament_players/room_players）。
 */

const TOKEN_SECRET = "hand-history-test-secret-0123456789abcdef";
const TOKEN_KEY_ID = "k1";
const NOW = 1_760_000_000_000;

interface PlayerFixture {
  readonly playerId: string;
  readonly token: string;
}

describeTestDatabase("hand history projection read: 鉴权/分页/隐私/损坏", (context) => {
  let testDb: IntegrationDatabase | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    testDb = await setupIntegrationDatabase(context);
    app = Fastify({ logger: false });
    registerHandHistoryRoutes(app, {
      repository: createHandHistoryRepository(testDb.database),
      tokenSecret: TOKEN_SECRET,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
      now: () => NOW,
      makeTraceId: randomUUID,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await testDb?.end();
  });

  function tokenOf(player: PlayerFixture): string {
    return `Bearer ${player.token}`;
  }

  async function injectGet(url: string, authorization?: string) {
    return app!.inject({
      method: "GET",
      url,
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  /** Room + n 名真人成员（各自持有独立 token 摘要）。 */
  async function createRoomFixture(label: string, memberCount: number): Promise<{ roomId: string; players: PlayerFixture[] }> {
    const roomId = randomUUID();
    const roomRepo = createRoomRepository(testDb!.database);
    const players: PlayerFixture[] = [];
    for (let i = 0; i < memberCount; i++) {
      const playerId = randomUUID();
      const token = `${label}-token-${i}-${"x".repeat(40)}`;
      players.push({ playerId, token });
      const tokenDigest = computePlayerTokenDigest({ roomId, playerId, token, keyId: TOKEN_KEY_ID, secret: TOKEN_SECRET });
      const displayName = `${label}-player-${i}`;
      if (i === 0) {
        await roomRepo.createRoomWithHost({
          roomId,
          mode: "MULTIPLAYER",
          inviteCode: generateInviteCode(),
          configJson: { maxPlayers: 6, startingStack: 1000 },
          host: { playerId, displayName, tokenDigest, tokenKeyId: TOKEN_KEY_ID },
        });
      } else {
        await roomRepo.insertRoomPlayer({
          roomId,
          playerId,
          displayName,
          displayNameKey: normalizeDisplayNameKey(displayName),
          kind: "HUMAN",
          tokenDigest,
          tokenKeyId: TOKEN_KEY_ID,
        });
      }
    }
    return { roomId, players };
  }

  /** Tournament + 锁定参赛者（seatIndex 与传入 players 下标一致）。 */
  async function createTournamentFixture(
    roomId: string,
    players: readonly PlayerFixture[],
  ): Promise<string> {
    const tournamentId = randomUUID();
    await createTournamentRepository(testDb!.database).createTournamentWithPlayers({
      tournamentId,
      roomId,
      tournamentNo: 1,
      configJson: { maxPlayers: 6, startingStack: 1000 },
      players: players.map((player, seatIndex) => ({
        id: randomUUID(),
        playerId: player.playerId,
        displayName: `seat-${seatIndex}`,
        seatIndex,
        kind: "HUMAN" as const,
        startingStack: 1000n,
      })),
    });
    return tournamentId;
  }

  /** 极简两手牌事件的 bundle（HAND_STARTED + PLAYER_FOLDED）。 */
  function simpleBundle(tournamentId: string, handId: string, handNumber: number, firstSequence: bigint): HandCommitBundle {
    const events: HandCommitEvent[] = [
      { sequence: firstSequence, handSequence: 1, type: "HAND_STARTED", payload: { handNumber, dealerSeat: 0, sbSeat: 1, bbSeat: 0 }, schemaVersion: 1 },
      { sequence: firstSequence + 1n, handSequence: 2, type: "PLAYER_FOLDED", payload: { seatIndex: 1, source: "human_socket" }, schemaVersion: 1 },
    ];
    return {
      tournamentId,
      hand: {
        id: handId,
        handNumber,
        dealerSeat: 0,
        sbSeat: 1,
        bbSeat: 0,
        blindLevelIndex: 0,
        smallBlind: 10n,
        bigBlind: 20n,
        communityCards: [],
        summary: { showdown: false, pots: [{ potIndex: 0, amount: 30, winners: [0] }], winners: [0] },
        endReason: "ALL_FOLDED" as const,
        startedAt: new Date(NOW + handNumber * 1000),
        endedAt: new Date(NOW + handNumber * 1000 + 60_000),
      },
      events,
      snapshot: {
        id: randomUUID(),
        sequence: firstSequence + 1n,
        state: { handNumber },
        schemaVersion: 1,
        engineVersion: "poker-engine@0.0.0-test",
        stateChecksum: sha256Checksum({ handNumber }),
        commitChecksum: sha256Checksum({ handId, handNumber }),
      },
      playerUpdates: [],
    };
  }

  it("鉴权：缺失 token → 401 AUTH_REQUIRED；无效 token → 401 AUTH_FAILED；非参赛者 → 403 FORBIDDEN；Tournament 不存在 → 404", async () => {
    const { roomId, players } = await createRoomFixture("auth", 3);
    const [playerA, , playerC] = players;
    const tournamentId = await createTournamentFixture(roomId, players.slice(0, 2));
    const commit = createHandCommitRepository(testDb!.database);
    await commit.commitHandBundle(simpleBundle(tournamentId, randomUUID(), 1, 1n));

    const listUrl = `/api/v1/tournaments/${tournamentId}/hands`;
    const missing = await injectGet(listUrl);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("AUTH_REQUIRED");

    const invalid = await injectGet(listUrl, "Bearer not-a-real-token-0000000000000000000000");
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe("AUTH_FAILED");

    const forbidden = await injectGet(listUrl, tokenOf(playerC));
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    const notFound = await injectGet(`/api/v1/tournaments/${randomUUID()}/hands`, tokenOf(playerA));
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe("ROOM_NOT_FOUND");
  });

  it("列表：handNumber 倒序 + cursor 分页（默认 20 / 上限 50），items 只含已提交手", async () => {
    const { roomId, players } = await createRoomFixture("page", 2);
    const [playerA] = players;
    const tournamentId = await createTournamentFixture(roomId, players);
    const commit = createHandCommitRepository(testDb!.database);
    for (let handNumber = 1; handNumber <= 25; handNumber++) {
      const firstSequence = BigInt((handNumber - 1) * 2 + 1);
      await commit.commitHandBundle(simpleBundle(tournamentId, randomUUID(), handNumber, firstSequence));
    }

    const listUrl = `/api/v1/tournaments/${tournamentId}/hands`;
    const first = await injectGet(listUrl, tokenOf(playerA));
    expect(first.statusCode).toBe(200);
    const firstBody = HandHistoryListResponseSchema.parse(first.json());
    expect(firstBody.data.items).toHaveLength(20);
    expect(firstBody.data.items.map((item) => item.handNumber)).toEqual(
      Array.from({ length: 20 }, (_, i) => 25 - i),
    );
    expect(firstBody.data.nextCursor).not.toBeNull();

    const second = await injectGet(`${listUrl}?cursor=${firstBody.data.nextCursor}`, tokenOf(playerA));
    expect(second.statusCode).toBe(200);
    const secondBody = HandHistoryListResponseSchema.parse(second.json());
    expect(secondBody.data.items.map((item) => item.handNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(secondBody.data.nextCursor).toBeNull();

    const full = await injectGet(`${listUrl}?limit=50`, tokenOf(playerA));
    const fullBody = HandHistoryListResponseSchema.parse(full.json());
    expect(fullBody.data.items).toHaveLength(25);
    expect(fullBody.data.nextCursor).toBeNull();

    // 列表项字段：公开投影（无隐藏信息列）。
    const item = firstBody.data.items[0];
    expect(item.handNumber).toBe(25);
    expect(item.smallBlind).toBe(10);
    expect(item.bigBlind).toBe(20);
    expect(item.communityCards).toEqual([]);
    expect(item.endReason).toBe("ALL_FOLDED");
    expect(item.potTotal).toBe(30);
    expect(item.winnerPlayerIds).toEqual([players[0].playerId]);
    expect(item.startedAt).toBe(NOW + 25_000);
    expect(item.endedAt).toBe(NOW + 25_000 + 60_000);
  });

  it("列表参数校验：limit 超范围/非整数与非法 cursor → 400 INVALID_MESSAGE", async () => {
    const { roomId, players } = await createRoomFixture("param", 2);
    const [playerA] = players;
    const tournamentId = await createTournamentFixture(roomId, players);
    const commit = createHandCommitRepository(testDb!.database);
    await commit.commitHandBundle(simpleBundle(tournamentId, randomUUID(), 1, 1n));
    const listUrl = `/api/v1/tournaments/${tournamentId}/hands`;

    for (const query of ["limit=0", "limit=51", "limit=abc", "limit=-1", "cursor=%21%21%21", "cursor=aGVsbG8td29ybGQ"]) {
      const response = await injectGet(`${listUrl}?${query}`, tokenOf(playerA));
      expect(response.statusCode, query).toBe(400);
      expect(response.json().error.code, query).toBe("INVALID_MESSAGE");
    }
  });

  it("详情：接收者视角投影——本人底牌带牌面、他人底牌无牌面、Burn 无牌面、Showdown 公开；Schema 合法", async () => {
    const { roomId, players } = await createRoomFixture("detail", 2);
    const [playerA, playerB] = players;
    const tournamentId = await createTournamentFixture(roomId, players);

    // Burn 牌（梅花 2）是全场唯一 clubs：断言响应不含该花色即证明 Burn 牌面被过滤。
    const richEvents: HandCommitEvent[] = [
      { sequence: 1n, handSequence: 1, type: "HAND_STARTED", payload: { handNumber: 1, dealerSeat: 0, sbSeat: 1, bbSeat: 0 }, schemaVersion: 1 },
      { sequence: 2n, handSequence: 2, type: "DEAL_HOLE_CARD", payload: { seatIndex: 0, holeNumber: 1, card: { suit: "spades", rank: 14 } }, schemaVersion: 1 },
      { sequence: 3n, handSequence: 3, type: "DEAL_HOLE_CARD", payload: { seatIndex: 1, holeNumber: 1, card: { suit: "hearts", rank: 13 } }, schemaVersion: 1 },
      { sequence: 4n, handSequence: 4, type: "BURN_CARD", payload: { street: "flop", card: { suit: "clubs", rank: 2 } }, schemaVersion: 1 },
      { sequence: 5n, handSequence: 5, type: "FLOP_DEALT", payload: { cards: [{ suit: "spades", rank: 2 }, { suit: "hearts", rank: 7 }, { suit: "diamonds", rank: 11 }] }, schemaVersion: 1 },
      { sequence: 6n, handSequence: 6, type: "PLAYER_REVEALED", payload: { seatIndex: 1, cards: [{ suit: "hearts", rank: 13 }, { suit: "hearts", rank: 9 }] }, schemaVersion: 1 },
      { sequence: 7n, handSequence: 7, type: "POT_AWARDED", payload: { potIndex: 0, amount: 60, winners: [1], prizeBySeat: { "1": 60 } }, schemaVersion: 1 },
    ];
    const handId = randomUUID();
    const communityCards = [{ suit: "spades", rank: 2 }, { suit: "hearts", rank: 7 }, { suit: "diamonds", rank: 11 }];
    await createHandCommitRepository(testDb!.database).commitHandBundle({
      tournamentId,
      hand: {
        id: handId,
        handNumber: 1,
        dealerSeat: 0,
        sbSeat: 1,
        bbSeat: 0,
        blindLevelIndex: 0,
        smallBlind: 10n,
        bigBlind: 20n,
        communityCards,
        summary: { showdown: true, pots: [{ potIndex: 0, amount: 60, winners: [1] }], winners: [1] },
        endReason: "SHOWDOWN" as const,
        startedAt: new Date(NOW),
        endedAt: new Date(NOW + 120_000),
      },
      events: richEvents,
      snapshot: {
        id: randomUUID(),
        sequence: 7n,
        state: { handNumber: 1 },
        schemaVersion: 1,
        engineVersion: "poker-engine@0.0.0-test",
        stateChecksum: sha256Checksum({ handNumber: 1 }),
        commitChecksum: sha256Checksum({ handId }),
      },
      playerUpdates: [],
    });

    const detailUrl = `/api/v1/tournaments/${tournamentId}/hands/${handId}`;
    const response = await injectGet(detailUrl, tokenOf(playerA));
    expect(response.statusCode).toBe(200);
    const body = HandHistoryDetailResponseSchema.parse(response.json());
    expect(body.data.tournamentId).toBe(tournamentId);
    expect(body.data.handId).toBe(handId);
    expect(body.data.startSequence).toBe("1");
    expect(body.data.endSequence).toBe("7");
    expect(body.data.events).toHaveLength(7);
    expect(body.data.events.map((message) => message.payload.sequence)).toEqual(
      ["1", "2", "3", "4", "5", "6", "7"],
    );

    const events = body.data.events.map((message) => message.payload.event);
    // A 视角：本人（seat 0）底牌带牌面；B（seat 1）底牌无 card 字段。
    expect(events[1]).toMatchObject({ type: "DEAL_HOLE_CARD", payload: { cardIndex: 0, card: { rank: "A", suit: "SPADES" } } });
    expect("card" in events[2].payload).toBe(false);
    // Burn：wire 只有 street，无牌面。
    expect(events[3]).toEqual({ type: "BURN_CARD", payload: { street: "FLOP" } });
    // Showdown 公开牌与结算。
    expect(events[4]).toMatchObject({ type: "FLOP_DEALT", payload: { cards: [{ rank: "2", suit: "SPADES" }, { rank: "7", suit: "HEARTS" }, { rank: "J", suit: "DIAMONDS" }] } });
    expect(events[5]).toMatchObject({ type: "PLAYER_REVEALED", payload: { cards: [{ rank: "K", suit: "HEARTS" }, { rank: "9", suit: "HEARTS" }], handRank: expect.anything() } });
    expect(events[6]).toMatchObject({ type: "POT_AWARDED", payload: { potAmount: 60, awards: [{ playerId: playerB.playerId, amount: 60 }] } });
    // 隐私红线：Burn 牌（全场唯一 clubs）不得出现在任何响应字节中。
    expect(response.body).not.toContain("clubs");
    expect(response.body).not.toContain("CLUBS");

    // B 视角：B 本人底牌带牌面；A 的底牌无 card 字段（接收者视角隔离）。
    const asB = await injectGet(detailUrl, tokenOf(playerB));
    expect(asB.statusCode).toBe(200);
    const bEvents = HandHistoryDetailResponseSchema.parse(asB.json()).data.events.map(
      (message) => message.payload.event,
    );
    expect("card" in bEvents[1].payload).toBe(false);
    expect(bEvents[2]).toMatchObject({ type: "DEAL_HOLE_CARD", payload: { cardIndex: 0, card: { rank: "K", suit: "HEARTS" } } });
  });

  it("详情权限：hand 不属于该 Tournament → 404；缺失 token → 401", async () => {
    const roomOne = await createRoomFixture("own1", 2);
    const roomTwo = await createRoomFixture("own2", 2);
    const tournamentOne = await createTournamentFixture(roomOne.roomId, roomOne.players);
    const tournamentTwo = await createTournamentFixture(roomTwo.roomId, roomTwo.players);
    const handId = randomUUID();
    const commit = createHandCommitRepository(testDb!.database);
    await commit.commitHandBundle(simpleBundle(tournamentTwo, handId, 1, 1n));

    const cross = await injectGet(
      `/api/v1/tournaments/${tournamentOne}/hands/${handId}`,
      tokenOf(roomOne.players[0]),
    );
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("ROOM_NOT_FOUND");

    const missing = await injectGet(`/api/v1/tournaments/${tournamentOne}/hands/${handId}`);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("损坏记录：事件无法投影或列表字段非法 → 500 INTERNAL_ERROR，不泄露细节", async () => {
    const { roomId, players } = await createRoomFixture("corrupt", 2);
    const [playerA] = players;
    const tournamentId = await createTournamentFixture(roomId, players);
    const commit = createHandCommitRepository(testDb!.database);

    const detailHandId = randomUUID();
    const listHandId = randomUUID();
    await commit.commitHandBundle(simpleBundle(tournamentId, detailHandId, 1, 1n));
    await commit.commitHandBundle(simpleBundle(tournamentId, listHandId, 2, 3n));

    // 注入损坏：PLAYER_FOLDED 事件丢失 seatIndex → 无法投影 → 500。
    await testDb!.adminPool.query(
      `UPDATE ${qualifiedTableName(testDb!.schemaName, "hand_events")} SET payload = '{"source":"human_socket"}'::jsonb WHERE hand_id = $1 AND type = 'PLAYER_FOLDED'`,
      [detailHandId],
    );
    const detail = await injectGet(`/api/v1/tournaments/${tournamentId}/hands/${detailHandId}`, tokenOf(playerA));
    expect(detail.statusCode).toBe(500);
    expect(detail.json().error.code).toBe("INTERNAL_ERROR");
    expect(detail.json().error.message).not.toContain("seatIndex");

    // 注入损坏：summary 无 winners → 列表项无法通过 Schema → 500。
    await testDb!.adminPool.query(
      `UPDATE ${qualifiedTableName(testDb!.schemaName, "hands")} SET summary = '{"showdown":false,"pots":[]}'::jsonb WHERE id = $1`,
      [listHandId],
    );
    const list = await injectGet(`/api/v1/tournaments/${tournamentId}/hands?limit=1`, tokenOf(playerA));
    expect(list.statusCode).toBe(500);
    expect(list.json().error.code).toBe("INTERNAL_ERROR");
  });
});
