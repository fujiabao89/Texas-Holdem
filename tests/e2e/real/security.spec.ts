/**
 * TEX-28 真实链路字段级安全测试（docs/06 §7、docs/02 §11）。
 *
 * 在真实浏览器 → 真实 web → 真实 game-server → 真实 PostgreSQL 链路上验证：
 * 1. WS 投影字段级隔离：以 DB hand_events 私有事实为权威对照，对手未公开
 *    底牌、Burn 牌、牌堆与 token 从未出现在任何客户端实际收到的帧中；
 * 2. 非空洞性：本人合法底牌（viewer.holeCards）与服务端公开牌仍可见——
 *    安全结论不靠删除全部牌数据达成；
 * 3. DEAL_HOLE_CARD 定向脱敏：发给其他玩家的发牌事件不含 card 字段；
 * 4. playerToken 只存在于 sessionStorage 与 Authorization 头：不落 URL、
 *    localStorage、IndexedDB 或任何网络请求查询串；
 * 5. HTTP 错误信封：未认证 / 伪造 Token / 非法 body 返回结构化错误，
 *    不含堆栈、SQL 或连接串。
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { test } from "../fixtures/observability";
import { joinRoomHttp, patchJson, postJson, type ApiErrorEnvelope } from "./support/api";
import {
  fetchTournamentGroundTruth,
  latestTournamentIdForRoom,
  type GroundTruthCard,
} from "./support/db";
import {
  createRoomViaUi,
  driveTournamentToFinish,
  enterTableWhenReady,
  joinViaUi,
  readInviteCode,
  startTournamentViaUi,
  takeSeatAndReady,
} from "./support/ui";

const RANK_NAMES = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
const RANKS = new Set<string>(RANK_NAMES);
const SUITS = new Set(["CLUBS", "DIAMONDS", "HEARTS", "SPADES"]);

/** 服务器私有键名：任何投影帧（原始字符串）都不允许出现。 */
const FORBIDDEN_FRAME_KEYS = [
  "privateHoleCards",
  "burnCards",
  "remainingDeck",
  "playerToken",
] as const;

/** 错误信封不允许出现的实现细节标记（堆栈 / SQL / 连接串）。 */
const ENVELOPE_LEAK_MARKERS = [
  "at Object.",
  "at Module.",
  "node:internal",
  "SELECT ",
  "INSERT INTO",
  "UPDATE ",
  "postgres://",
] as const;

function truthCardKey(card: GroundTruthCard): string {
  const rank = RANK_NAMES[card.rank - 2];
  if (rank === undefined) throw new Error(`未知牌面 rank=${card.rank}`);
  return `${rank}|${card.suit}`;
}

/** 递归收集 JSON 树中所有 CardSchema 形状（rank+suit 枚举）的牌。 */
function collectWireCards(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectWireCards(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.rank === "string" &&
    typeof record.suit === "string" &&
    RANKS.has(record.rank) &&
    SUITS.has(record.suit)
  ) {
    into.add(`${record.rank}|${record.suit}`);
  }
  for (const child of Object.values(record)) collectWireCards(child, into);
}

interface CapturedSocket {
  readonly url: string;
  readonly frames: string[];
}

/** 捕获页面全部 WS 连接的服务端帧（真实客户端实际收到的序列化数据）。 */
function captureWebSocketFrames(page: Page): CapturedSocket[] {
  const sockets: CapturedSocket[] = [];
  page.on("websocket", (ws) => {
    const socket: CapturedSocket = { url: ws.url(), frames: [] };
    sockets.push(socket);
    ws.on("framereceived", (frame) => {
      socket.frames.push(typeof frame.payload === "string" ? frame.payload : String(frame.payload));
    });
  });
  return sockets;
}

interface SocketAudit {
  ownPlayerId: string | null;
  readonly ownHoleCards: Set<string>;
  readonly receivedCards: Set<string>;
  dealEventsToOthers: number;
  dealEventsWithCardToOthers: number;
}

/** 逐帧审计一个 socket：抽取 viewer 身份/底牌、全部到达牌与定向脱敏计数。 */
function auditSocket(socket: CapturedSocket): SocketAudit {
  const audit: SocketAudit = {
    ownPlayerId: null,
    ownHoleCards: new Set<string>(),
    receivedCards: new Set<string>(),
    dealEventsToOthers: 0,
    dealEventsWithCardToOthers: 0,
  };
  for (const frame of socket.frames) {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      continue; // 非 JSON 帧（心跳等）：原始键扫描已覆盖。
    }
    const record = message as { type?: unknown; payload?: unknown };
    if (record.type === "GAME_SNAPSHOT" || record.type === "RECONNECT_RESULT") {
      const payload = record.payload as Record<string, unknown> | undefined;
      const snapshot =
        record.type === "GAME_SNAPSHOT"
          ? payload
          : ((payload?.gameSnapshot ?? null) as Record<string, unknown> | null);
      const viewer = snapshot?.viewer as { playerId?: unknown; holeCards?: unknown } | undefined;
      if (viewer !== undefined && typeof viewer.playerId === "string")
        audit.ownPlayerId = viewer.playerId;
      if (viewer !== undefined) collectWireCards(viewer.holeCards, audit.ownHoleCards);
    }
    if (record.type === "GAME_EVENT") {
      const payload = record.payload as
        | {
            event?: { type?: unknown; payload?: Record<string, unknown> };
            patch?: { viewer?: { playerId?: unknown; holeCards?: unknown } };
          }
        | undefined;
      // 网关按 viewer 路由，每条 GAME_EVENT 的 patch.viewer 即本 socket 的接收者；
      // 据此识别自身身份，避免把发给本人的 DEAL（含 card）误判为「给他人且带 card」。
      if (typeof payload?.patch?.viewer?.playerId === "string")
        audit.ownPlayerId = payload.patch.viewer.playerId;
      if (payload?.event?.type === "DEAL_HOLE_CARD") {
        const eventPayload = payload.event.payload ?? {};
        if (
          typeof eventPayload.playerId === "string" &&
          eventPayload.playerId !== audit.ownPlayerId
        ) {
          audit.dealEventsToOthers += 1;
          if ("card" in eventPayload) audit.dealEventsWithCardToOthers += 1;
        }
      }
      collectWireCards(payload?.patch?.viewer?.holeCards, audit.ownHoleCards);
    }
    collectWireCards(message, audit.receivedCards);
  }
  return audit;
}

function assertEnvelopeSanitized(body: ApiErrorEnvelope): void {
  expect(typeof body.error?.code, "错误信封缺 error.code").toBe("string");
  expect(typeof body.error?.message, "错误信封缺 error.message").toBe("string");
  const text = JSON.stringify(body);
  for (const marker of ENVELOPE_LEAK_MARKERS) {
    expect(text, `错误信封泄露实现细节：${marker}`).not.toContain(marker);
  }
}

test.describe("真实链路字段级安全", () => {
  test("WS 投影隔离：对手未公开底牌永不到达客户端，本人与公开牌可见 @key", async ({
    browser,
    page,
    diagnostics,
  }) => {
    test.setTimeout(240_000);
    // 预期内的 WS 连接中断噪声（页面导航/关闭时传输 teardown），非产品缺陷：
    // 浏览器在 CONNECTING 中随导航断开会打印此类错误（Firefox/WebKit 明显）。
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    const aliceSockets = captureWebSocketFrames(page);
    const bobSockets = captureWebSocketFrames(bob);

    await createRoomViaUi(page, {
      displayName: "玩家一",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });
    const roomId = (await page.url()).split("/").pop() ?? "";
    const inviteCode = await readInviteCode(page);
    await joinViaUi(bob, inviteCode, "玩家乙");
    await takeSeatAndReady(page);
    await takeSeatAndReady(bob);
    await startTournamentViaUi(page);
    await enterTableWhenReady(bob);
    await driveTournamentToFinish([page, bob]);
    await expect(page.getByText("比赛已结束")).toBeVisible();

    // 数据库权威事实：全部真实底牌 + 公开牌（公共牌与摊牌亮牌）。
    const tournamentId = await latestTournamentIdForRoom(roomId);
    const hands = await fetchTournamentGroundTruth(tournamentId);
    expect(hands.length).toBeGreaterThanOrEqual(1);
    const publicCards = new Set<string>();
    for (const hand of hands) {
      for (const card of hand.boardCards) publicCards.add(truthCardKey(card));
      for (const cards of hand.revealedCardsBySeat.values()) {
        for (const card of cards) publicCards.add(truthCardKey(card));
      }
    }

    const allReceived = new Set<string>();
    for (const [label, sockets] of [
      ["Alice", aliceSockets],
      ["Bob", bobSockets],
    ] as const) {
      expect(sockets.length, `${label} 应建立 WS 连接`).toBeGreaterThan(0);
      for (const socket of sockets) {
        // WS URL 不携带 token（认证经首条消息，docs/02 §4）。
        expect(socket.url).not.toMatch(/[?&](token|authorization)=/i);
        // 原始帧键扫描：服务器私有字段与 token 键名永不出现。
        for (const frame of socket.frames) {
          for (const key of FORBIDDEN_FRAME_KEYS) {
            expect(frame, `${label} 帧包含私有键 ${key}`).not.toContain(key);
          }
        }
      }
      // 只审计真实游戏 socket（/api/v1/ws）：Next dev 的 HMR/overlay 连接（turbopack 等）
      // 是框架内部通道，不含应用数据，不能参与牌面/脱敏断言。
      const gameSockets = sockets.filter((socket) => socket.url.includes("/api/v1/ws"));
      expect(gameSockets.length, `${label} 应建立游戏 WS 连接`).toBeGreaterThan(0);
      let ownDealEventsToOthers = 0;
      for (const socket of gameSockets) {
        const audit = auditSocket(socket);
        for (const card of audit.receivedCards) allReceived.add(card);
        // 非空洞性：收到过快照的客户端都实际收到了自己的底牌。
        if (audit.ownPlayerId !== null) {
          expect(audit.ownHoleCards.size, `${label} 应收到本人底牌`).toBeGreaterThanOrEqual(2);
        }
        // 核心断言：到达的每张牌 ∈（本人底牌 ∪ 服务端公开牌）。
        for (const card of audit.receivedCards) {
          expect(
            publicCards.has(card) || audit.ownHoleCards.has(card),
            `${label} 收到未公开牌 ${card}`,
          ).toBe(true);
        }
        // 定向脱敏（每 socket 安全边界）：发给其他玩家的 DEAL_HOLE_CARD 事件不含 card 字段。
        ownDealEventsToOthers += audit.dealEventsToOthers;
        expect(audit.dealEventsWithCardToOthers, `${label} 他人发牌事件泄露 card`).toBe(0);
      }
      // 非空洞性（每玩家聚合）：开局时在线的游戏 socket 确实收到过他人（脱敏）发牌事件。
      expect(ownDealEventsToOthers, `${label} 应收到他人发牌事件（脱敏后）`).toBeGreaterThan(0);
    }

    // 非空洞性：最后一手全下摊牌的亮牌确实到达了客户端。
    const finalHand = hands[hands.length - 1];
    expect(finalHand.revealedCardsBySeat.size).toBeGreaterThanOrEqual(2);
    for (const cards of finalHand.revealedCardsBySeat.values()) {
      for (const card of cards) expect(allReceived.has(truthCardKey(card))).toBe(true);
    }

    await bobContext.close();
  });

  test("playerToken 只存在于 sessionStorage 与 Authorization 头，不落 URL 与持久存储", async ({
    page,
  }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await createRoomViaUi(page, {
      displayName: "玩家一",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });

    // 身份只在当前 Tab 的 sessionStorage（token-store.ts 契约）。
    // Storage 无标准 entries()（Chromium 不实现）：用 key(i) 逐项枚举。
    const session = await page.evaluate(() => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key !== null) entries[key] = sessionStorage.getItem(key) ?? "";
      }
      return entries;
    });
    const tokenKeys = Object.keys(session).filter((key) => key.includes("player-token"));
    expect(tokenKeys).toHaveLength(1);
    const token = session[tokenKeys[0]] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);

    // Token 不进入任何网络请求 URL（含 WS 握手）。
    for (const url of requestUrls) {
      expect(url, "token 泄露进请求 URL").not.toContain(token);
    }
    expect(page.url()).not.toContain(token);

    // 不落 localStorage / IndexedDB（持久存储）。
    const local = await page.evaluate(() => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) entries[key] = localStorage.getItem(key) ?? "";
      }
      return JSON.stringify(entries);
    });
    expect(local).toBe("{}");
    const databases = await page.evaluate(() =>
      typeof indexedDB.databases === "function" ? indexedDB.databases() : [],
    );
    // Next.js dev 模式自建调试通道库（__next* 前缀，属框架内部，非应用数据）；
    // 断言过滤后为空，即应用自身从未创建任何 IndexedDB 库。
    const appDatabases = (databases as ReadonlyArray<{ name?: string }>).filter(
      (database) => !(database.name ?? "").startsWith("__next"),
    );
    expect(appDatabases).toHaveLength(0);
  });

  test("HTTP 错误信封：未认证/伪造 Token/非法 body/越权无堆栈与 SQL 泄露", async ({ page }) => {
    await createRoomViaUi(page, {
      displayName: "玩家一",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });
    const roomId = (await page.url()).split("/").pop() ?? "";
    const inviteCode = await readInviteCode(page);

    // 未认证访问受保护端点。
    const unauthenticated = await patchJson(`/api/v1/rooms/${roomId}`, {
      expectedRoomRevision: "1",
      operation: { type: "CHANGE_SEAT", seat: 0 },
    });
    expect(unauthenticated.status).toBe(401);
    assertEnvelopeSanitized(unauthenticated.body);

    // 伪造 token。
    const forged = await patchJson(
      `/api/v1/rooms/${roomId}`,
      { expectedRoomRevision: "1", operation: { type: "CHANGE_SEAT", seat: 0 } },
      { token: `forged-${randomUUID()}` },
    );
    expect([401, 403]).toContain(forged.status);
    assertEnvelopeSanitized(forged.body);

    // 非法邀请码。
    const badJoin = await postJson("/api/v1/rooms/join", {
      inviteCode: "ZZZZZZ",
      displayName: "玩家三",
    });
    expect([400, 404]).toContain(badJoin.status);
    assertEnvelopeSanitized(badJoin.body);

    // 非法 body（违反 Schema）。
    const malformed = await postJson("/api/v1/rooms/join", {
      inviteCode: 12345,
      displayName: null,
    });
    expect([400, 422]).toContain(malformed.status);
    assertEnvelopeSanitized(malformed.body);

    // 越权：真实 token 操作不存在的房间。
    const outsider = await joinRoomHttp(inviteCode, "玩家三");
    const crossRoom = await patchJson(
      `/api/v1/rooms/${randomUUID()}`,
      { expectedRoomRevision: "1", operation: { type: "CHANGE_SEAT", seat: 0 } },
      { token: outsider.playerToken },
    );
    expect([401, 403, 404]).toContain(crossRoom.status);
    assertEnvelopeSanitized(crossRoom.body);
  });
});
