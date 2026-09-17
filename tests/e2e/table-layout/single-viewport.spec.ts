import { resolve } from "node:path";

import { PROTOCOL_VERSION } from "../../../packages/protocol/src";
import { expect, test } from "../fixtures/observability";
import type { Page, TestInfo } from "@playwright/test";

/**
 * TEX-46 单视口牌桌与按需行动区回归。
 *
 * 权威：docs/05-frontend-spec.md §7.5/§8.1/§16、docs/06-testing-strategy.md §3.3/§9。
 * 使用既有 WS 投影夹具驱动真实浏览器布局；不依赖真实 game-server、DB 或 sleep。
 */

const VIEWPORTS = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1920x1080", width: 1920, height: 1080 },
] as const;

const SEAT_COUNTS = [2, 3, 6, 10] as const;

function roomSnapshot(playerCount: number) {
  return {
    snapshotVersion: 1,
    roomId: "room-1",
    roomRevision: "1",
    status: "IN_GAME",
    inviteCode: "ABC234",
    hostPlayerId: "player-1",
    config: {
      maxPlayers: playerCount,
      startingStack: 1000,
      smallBlind: 5,
      bigBlind: 10,
      blindMode: "fixed",
      blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
      actionTime: 30,
      timeBank: 60,
    },
    activeTournamentId: "tournament-1",
    players: Array.from({ length: playerCount }, (_, seat) => ({
      playerId: `player-${seat + 1}`,
      displayName: `玩家${seat + 1}`,
      seat,
      ready: true,
      connectionStatus: "CONNECTED",
      pokerStatus: "ACTIVE",
    })),
  };
}

function gameSnapshot(playerCount: number) {
  return {
    snapshotVersion: 1,
    reason: "INITIAL",
    tournamentId: "tournament-1",
    sequence: "1",
    handId: "hand-1",
    tournamentStatus: "RUNNING",
    handPhase: "FLOP",
    blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 },
    dealerSeat: 0,
    board: [
      { rank: "A", suit: "SPADES" },
      { rank: "K", suit: "HEARTS" },
      { rank: "2", suit: "CLUBS" },
    ],
    pots: [
      {
        amount: 90,
        eligiblePlayerIds: Array.from({ length: playerCount }, (_, seat) => `player-${seat + 1}`),
      },
    ],
    currentActorPlayerId: "player-1",
    actionDeadline: 50_000,
    players: Array.from({ length: playerCount }, (_, seat) => ({
      playerId: `player-${seat + 1}`,
      displayName: `玩家${seat + 1}`,
      seat,
      stack: 990 - seat,
      streetBet: seat === 0 ? 10 : 5,
      totalCommitted: seat === 0 ? 10 : 5,
      pokerStatus: "ACTIVE",
      hasHoleCards: true,
      revealedCards: [],
    })),
    viewer: {
      playerId: "player-1",
      role: "PLAYER",
      holeCards: [
        { rank: "Q", suit: "SPADES" },
        { rank: "J", suit: "SPADES" },
      ],
      legalActions: {
        canFold: true,
        canCheck: false,
        canCall: true,
        callAmount: 5,
        canBet: false,
        minBetTo: null,
        canRaise: true,
        minRaiseTo: 20,
        maxRaiseTo: 990,
        canAllIn: true,
        allInTo: 1000,
      },
      timeBankRemainingMs: 60_000,
    },
    rankings: [],
  };
}

async function seedTableSession(page: Page): Promise<void> {
  await page.addInitScript(
    'sessionStorage.setItem("texas-holdem:player-token:room-1", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");sessionStorage.setItem("texas-holdem:player-id:room-1", "player-1");',
  );
}

async function openTable(
  page: Page,
  playerCount: number,
  commands?: unknown[],
): Promise<(payload: unknown) => void> {
  let push: ((payload: unknown) => void) | undefined;
  await seedTableSession(page);
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    push = (payload) => socket.send(JSON.stringify(payload));
    socket.onMessage((raw) => {
      const incoming = JSON.parse(raw.toString()) as { type: string };
      commands?.push(incoming);
      if (incoming.type !== "AUTHENTICATE") return;
      socket.send(
        JSON.stringify({
          type: "RECONNECT_RESULT",
          protocolVersion: PROTOCOL_VERSION,
          serverTime: 1,
          payload: {
            connectionId: "connection-1",
            resumed: true,
            tookOver: false,
            roomSnapshot: roomSnapshot(playerCount),
            gameSnapshot: gameSnapshot(playerCount),
          },
        }),
      );
    });
  });
  await page.goto("/room/room-1/table");
  // The socket callback runs after `goto`, so hand back a closure rather than
  // capturing the binding's current (still undefined) value.
  return (payload: unknown) => push!(payload);
}

/** 把手牌交还给服务端投影中的下一位行动者。 */
function passTurn(): unknown {
  return {
    type: "GAME_EVENT",
    protocolVersion: PROTOCOL_VERSION,
    serverTime: 2,
    payload: {
      tournamentId: "tournament-1",
      sequence: "2",
      handId: "hand-1",
      event: {
        type: "PLAYER_CALLED",
        payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET", amount: 5, betTo: 15 },
      },
      patch: { currentActorPlayerId: "player-2", viewer: { legalActions: null } },
    },
  };
}

type Box = {
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

async function boxes(
  page: Page,
  selectors: Readonly<Record<string, string>>,
): Promise<Record<string, Box | null>> {
  return page.evaluate(
    (entries) => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return Object.fromEntries(
        Object.entries(entries).map(([key, selector]) => [key, read(selector)]),
      );
    },
    selectors as Record<string, string>,
  );
}

/** 各目标视口的本地验收证据，沿用 TEX-38 的 `output/playwright/` 约定。 */
async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = resolve("output", "playwright", `TEX-46-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function overlaps(left: Box, right: Box): boolean {
  const gap = 0.5;
  return (
    left.x < right.right - gap &&
    right.x < left.right - gap &&
    left.y < right.bottom - gap &&
    right.y < left.bottom - gap
  );
}

test.describe("单视口牌桌", () => {
  for (const viewport of VIEWPORTS) {
    for (const seats of SEAT_COUNTS) {
      test(`${viewport.name} ${seats} 人桌在行动时不需要页面滚动`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openTable(page, seats);
        await expect(page.getByRole("button", { name: "跟注 5" })).toBeVisible();

        const metrics = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
        }));
        expect(metrics.scrollHeight, "页面不得纵向滚动").toBeLessThanOrEqual(
          metrics.innerHeight + 1,
        );
        expect(metrics.scrollWidth, "页面不得横向滚动").toBeLessThanOrEqual(metrics.innerWidth + 1);
        await expect(page.locator("[data-seat]")).toHaveCount(seats);

        const found = await boxes(page, {
          felt: ".rr-table-felt",
          board: ".table-board-zone",
          pot: "[data-pot-total]",
          dock: ".table-action-dock",
          panel: ".rr-betting-panel",
        });

        for (const [name, box] of Object.entries(found)) {
          expect(box, `${name} 必须存在`).not.toBeNull();
          expect(box!.x, `${name} 不得横向溢出`).toBeGreaterThanOrEqual(-1);
          expect(box!.right, `${name} 不得横向溢出`).toBeLessThanOrEqual(viewport.width + 1);
          expect(box!.y, `${name} 不得纵向溢出`).toBeGreaterThanOrEqual(-1);
          expect(box!.bottom, `${name} 必须完整落在视口内`).toBeLessThanOrEqual(
            viewport.height + 1,
          );
        }

        // 行动区不得遮挡公共牌、底池或任何座位（docs/05 §7.3/§8.1）。
        expect(overlaps(found.dock!, found.board!), "行动区不得遮挡公共牌").toBe(false);
        expect(overlaps(found.dock!, found.pot!), "行动区不得遮挡底池").toBe(false);
        const seatsUnderDock = await page.locator("[data-seat]").evaluateAll(
          (elements, dock) =>
            elements
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                const gap = 0.5;
                return (
                  rect.left < dock.right - gap &&
                  dock.x < rect.right - gap &&
                  rect.top < dock.bottom - gap &&
                  dock.y < rect.bottom - gap
                );
              })
              .map((element) => element.getAttribute("aria-label") ?? "?"),
          found.dock!,
        );
        expect(seatsUnderDock, "行动区不得遮挡座位").toEqual([]);
      });

      test(`${viewport.name} ${seats} 人桌座位卡片互不重叠`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openTable(page, seats);
        await expect(page.getByRole("button", { name: "跟注 5" })).toBeVisible();
        // Wait for the whole Seat ring before measuring; a partially painted
        // ring would report boxes that later move.
        await expect(page.locator("[data-seat]")).toHaveCount(seats);

        const seatsBoxes = await page.locator("[data-seat]").evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.getAttribute("aria-label") ?? "?",
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            };
          }),
        );

        const intersecting = seatsBoxes.flatMap((seat, index) =>
          seatsBoxes
            .slice(index + 1)
            .filter((other) => overlaps(seat, other))
            .map((other) => `${seat.name} 与 ${other.name} 相交`),
        );
        expect(intersecting, "座位卡片不得相交").toEqual([]);
      });

      test(`${viewport.name} ${seats} 人桌全部合法操作在行动区内可达`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openTable(page, seats);
        const panel = page.locator(".rr-betting-panel");
        await expect(panel).toBeVisible();

        for (const name of ["弃牌", "跟注 5", "加注", "全下至 1000", "使用延时"]) {
          const button = page.getByRole("button", { name });
          await expect(button, `${name} 必须可见`).toBeVisible();
          const box = await button.boundingBox();
          expect(box, `${name} 必须有布局`).not.toBeNull();
          expect(box!.x, `${name} 不得横向溢出`).toBeGreaterThanOrEqual(-1);
          expect(box!.x + box!.width, `${name} 不得横向溢出`).toBeLessThanOrEqual(
            viewport.width + 1,
          );
          expect(box!.y, `${name} 不得纵向溢出`).toBeGreaterThanOrEqual(-1);
          expect(box!.y + box!.height, `${name} 必须完整落在视口内`).toBeLessThanOrEqual(
            viewport.height + 1,
          );
        }
      });
    }
  }
});

test.describe("验收证据", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} 十人桌行动中`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openTable(page, 10);
      await expect(page.getByRole("button", { name: "跟注 5" })).toBeVisible();
      await expect(page.locator("[data-seat]")).toHaveCount(10);
      await captureEvidence(page, testInfo, `${viewport.name}-10p`);
    });
  }

  test("390x844 金额面板展开", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTable(page, 6);
    await page.getByRole("button", { name: "加注" }).click();
    await expect(page.locator(".table-wager-editor")).toBeVisible();
    await captureEvidence(page, testInfo, "390x844-wager");
  });
});

test.describe("按需行动区", () => {
  test("行动区随行动权出现和消失，且不改变牌桌几何", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const push = await openTable(page, 6);
    const felt = page.locator(".rr-table-felt");
    await expect(page.getByRole("button", { name: "跟注 5" })).toBeVisible();
    const acting = await felt.boundingBox();

    push(passTurn());

    await expect(page.locator(".table-action-dock")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "跟注 5" })).toHaveCount(0);
    expect(await felt.boundingBox(), "行动区消失不得改变牌桌几何").toEqual(acting);
  });

  test("非本人回合不渲染任何可提交控件", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const push = await openTable(page, 3);
    await expect(page.getByRole("button", { name: "跟注 5" })).toBeVisible();
    push(passTurn());
    await expect(page.locator(".rr-betting-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "弃牌" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "使用延时" })).toHaveCount(0);
  });

  for (const viewport of [
    { name: "360x800", width: 360, height: 800 },
    { name: "390x844", width: 390, height: 844 },
  ] as const) {
    test(`${viewport.name} 精确金额模式既不滚动页面也不滚动面板`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openTable(page, 6);

      await page.getByRole("button", { name: "加注" }).click();
      await page.getByRole("button", { name: "输入精确金额" }).click();
      const field = page.getByRole("textbox", { name: "输入精确下注额" });
      await expect(field).toBeVisible();
      await field.fill("42");

      // 面板不得内部溢出：所有可见控件的矩形必须完整位于面板矩形内。
      const measured = await page.evaluate(() => {
        const panel = document.querySelector(".rr-betting-panel");
        if (panel === null) throw new Error("missing wager panel");
        const panelRect = panel.getBoundingClientRect();
        const controls = Array.from(panel.querySelectorAll("button, input, output"))
          .filter((element) => {
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden") return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.getAttribute("aria-label") ?? element.textContent ?? element.tagName,
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
            };
          });
        return {
          panelScrollHeight: panel.scrollHeight,
          panelClientHeight: panel.clientHeight,
          panel: {
            top: panelRect.top,
            bottom: panelRect.bottom,
            left: panelRect.left,
            right: panelRect.right,
          },
          documentScrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          controls,
        };
      });

      expect(measured.panelScrollHeight, "精确金额面板不得内部滚动").toBeLessThanOrEqual(
        measured.panelClientHeight + 1,
      );
      expect(measured.documentScrollHeight, "页面不得滚动").toBeLessThanOrEqual(
        measured.viewportHeight + 1,
      );
      expect(measured.controls.length, "面板内必须有可见控件").toBeGreaterThan(0);
      for (const control of measured.controls) {
        expect(control.top, `${control.name} 必须完整位于面板内`).toBeGreaterThanOrEqual(
          measured.panel.top - 1,
        );
        expect(control.bottom, `${control.name} 必须完整位于面板内`).toBeLessThanOrEqual(
          measured.panel.bottom + 1,
        );
        expect(control.left, `${control.name} 必须完整位于面板内`).toBeGreaterThanOrEqual(
          measured.panel.left - 1,
        );
        expect(control.right, `${control.name} 必须完整位于面板内`).toBeLessThanOrEqual(
          measured.panel.right + 1,
        );
        expect(control.bottom, `${control.name} 必须完整位于视口内`).toBeLessThanOrEqual(
          measured.viewportHeight + 1,
        );
      }
    });
  }

  test("精确金额可返回主操作行，并可提交", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const commands: { type: string; payload?: { action?: { type: string; raiseTo?: number } } }[] =
      [];
    await openTable(page, 6, commands);
    const panel = page.locator(".rr-betting-panel");

    // 打开精确输入后仍可退回主操作行。
    await page.getByRole("button", { name: "加注" }).click();
    await page.getByRole("button", { name: "输入精确金额" }).click();
    await expect(page.getByRole("textbox", { name: "输入精确下注额" })).toBeVisible();
    await page.getByRole("button", { name: "返回操作" }).click();
    await expect(panel).toHaveAttribute("data-wager-open", "false");
    await expect(page.getByRole("button", { name: "全下至 1000" })).toBeEnabled();

    // 重新进入并把仍聚焦的合法草稿在当前交互中提交。
    await page.getByRole("button", { name: "加注" }).click();
    await page.getByRole("button", { name: "输入精确金额" }).click();
    await page.getByRole("textbox", { name: "输入精确下注额" }).fill("42");
    // 按钮文案跟随滑杆值，精确草稿在提交时被采用（TEX-25 既有契约）。
    await page.getByRole("button", { name: /确认加注至/ }).click();
    await expect.poll(() => commands.filter(({ type }) => type === "SUBMIT_ACTION").length).toBe(1);
    expect(commands.find(({ type }) => type === "SUBMIT_ACTION")).toMatchObject({
      payload: { action: { type: "RAISE", raiseTo: 42 } },
    });
  });
});
