import type { Page } from "@playwright/test";

import { message } from "../../../apps/web/src/messages/zh-CN";
import { expect, test } from "../fixtures/observability";
import { installSeatTable, seatSlots, seatTableSnapshot } from "./table-fixture";

type Rect = { readonly l: number; readonly r: number; readonly t: number; readonly b: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

function badge(page: Page, seat: number, kind: "D" | "SB" | "BB") {
  return page.locator(`[data-seat="${seat}"] [data-seat-badge="${kind}"]`);
}

/** The Latin text is decorative; assistive tech must receive the Chinese role name. */
async function expectBadgeName(page: Page, seat: number, kind: "D" | "SB" | "BB", accessibleName: string): Promise<void> {
  const locator = badge(page, seat, kind);
  await expect(locator).toHaveRole("img");
  await expect(locator).toHaveAccessibleName(accessibleName);
}

test("Heads-up 的 D=SB 同座显示，弃牌与跨手盲注移动不改变座位位置", async ({ page }) => {
  const table = await installSeatTable(page, seatTableSnapshot({ playerCount: 2, viewerSeat: 0, dealerSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1, currentActorSeat: 0 }));
  await table.open();
  const before = await seatSlots(page);
  expect(before).toEqual({ "0": "5", "1": "6" });

  await expectBadgeName(page, 0, "D", message("table.badges.dealer"));
  await expectBadgeName(page, 0, "SB", message("table.badges.smallBlind"));
  await expectBadgeName(page, 1, "BB", message("table.badges.bigBlind"));
  await expect(page.locator("[data-seat-badge]")).toHaveCount(3);

  table.event(
    { type: "PLAYER_FOLDED", payload: { playerId: "player-1", seat: 0, source: "HUMAN_SOCKET" } },
    { handPhase: "HAND_END", currentActorPlayerId: null, players: [{ playerId: "player-1", hasHoleCards: false }] },
  );
  await expect(page.locator('[data-active="true"]')).toHaveCount(0);
  expect(await seatSlots(page)).toEqual(before);

  table.event(
    { type: "HAND_STARTED", payload: { handNumber: 2, dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0, blindLevel: 0 } },
    { handId: "hand-2", handPhase: "PREFLOP", dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0, board: [], currentActorPlayerId: "player-2", players: [{ playerId: "player-1", hasHoleCards: true }, { playerId: "player-2", hasHoleCards: true }] },
  );
  await expect(badge(page, 1, "D")).toHaveCount(1);
  await expect(badge(page, 1, "SB")).toHaveCount(1);
  await expect(badge(page, 0, "BB")).toHaveCount(1);
  await expect(page.locator("[data-seat-badge]")).toHaveCount(3);
  expect(await seatSlots(page)).toEqual(before);
});

test("6 人桌按相对 seatIndex 顺时针固定映射，行动者切换与淘汰不移动座位", async ({ page }) => {
  const table = await installSeatTable(page, seatTableSnapshot({ playerCount: 6, viewerSeat: 2, dealerSeat: 1, smallBlindSeat: 2, bigBlindSeat: 3, currentActorSeat: 4 }));
  await table.open();
  const before = await seatSlots(page);
  expect(before).toEqual({ "0": "3", "1": "4", "2": "5", "3": "6", "4": "7", "5": "8" });

  await expect(badge(page, 1, "D")).toHaveCount(1);
  await expect(badge(page, 2, "SB")).toHaveCount(1);
  await expect(badge(page, 3, "BB")).toHaveCount(1);
  await expect(page.locator('[data-seat="4"][data-active="true"]')).toHaveCount(1);

  table.event(
    { type: "PLAYER_CHECKED", payload: { playerId: "player-5", seat: 4, source: "HUMAN_SOCKET" } },
    { currentActorPlayerId: "player-2" },
  );
  await expect(page.locator('[data-seat="1"][data-active="true"]')).toHaveCount(1);
  expect(await seatSlots(page)).toEqual(before);

  table.event(
    { type: "PLAYER_ELIMINATED", payload: { playerId: "player-6", finishPosition: 6, tied: false } },
    { handPhase: "HAND_END", currentActorPlayerId: null, players: [{ playerId: "player-6", pokerStatus: "ELIMINATED", stack: 0, hasHoleCards: false }] },
  );
  await expect(badge(page, 1, "D")).toBeVisible();
  await expect(page.locator('[data-seat="5"] [data-seat-name]')).toBeVisible();
  expect(await seatSlots(page)).toEqual(before);
});

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`10 人桌 ${viewport.width}×${viewport.height} 座位唯一无重叠，长昵称与大额筹码仍可区分盲注`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const table = await installSeatTable(page, seatTableSnapshot({
      playerCount: 10, viewerSeat: 0, dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, currentActorSeat: 3,
      configure: (players) => players.map((player) => player.seat === 2
        ? { ...player, displayName: "超长昵称测试玩家三号", stack: 5_000_000 }
        : player.seat === 4
          ? { ...player, displayName: "超长昵称测试玩家五号", stack: 999_999_999 }
          : player),
    }));
    await table.open();

    const layout = await page.evaluate(() => {
      const rect = (element: Element | null): { l: number; r: number; t: number; b: number } | null => {
        if (element === null) return null;
        const box = element.getBoundingClientRect();
        return { l: box.left, r: box.right, t: box.top, b: box.bottom };
      };
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        seats: Array.from(document.querySelectorAll("[data-seat]")).map((seat) => ({
          seat: seat.getAttribute("data-seat"),
          slot: seat.getAttribute("data-seat-slot"),
          rect: rect(seat),
          badges: Array.from(seat.querySelectorAll("[data-seat-badges]")).map(rect),
          name: rect(seat.querySelector("[data-seat-name]")),
          stack: rect(seat.querySelector("[data-seat-stack]")),
          cards: rect(seat.querySelector("[data-seat-cards]")),
        })),
      };
    });

    const slots = layout.seats.map((seat) => seat.slot);
    expect(layout.seats).toHaveLength(10);
    expect(new Set(slots).size).toBe(10);
    expect(Object.fromEntries(layout.seats.map((seat) => [seat.seat, seat.slot]))).toEqual(
      Object.fromEntries(layout.seats.map((seat) => [seat.seat, String((5 + Number(seat.seat)) % 10)])),
    );
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

    const badgeRects = layout.seats.flatMap((seat) => seat.badges);
    expect(badgeRects.filter((rect) => rect !== null)).toHaveLength(3);
    for (const seat of layout.seats) {
      expect(seat.rect, `seat ${seat.seat} must stay inside the viewport`).not.toBeNull();
      if (seat.rect === null) continue;
      expect(seat.rect.l).toBeGreaterThanOrEqual(0);
      expect(seat.rect.r).toBeLessThanOrEqual(layout.viewportWidth);
    }
    const seatRects = layout.seats.flatMap((seat) => seat.rect === null ? [] : [seat.rect]);
    for (let index = 0; index < seatRects.length; index += 1) {
      for (let other = index + 1; other < seatRects.length; other += 1) {
        expect(intersects(seatRects[index]!, seatRects[other]!), `seat ${index} must not intersect seat ${other}`).toBe(false);
      }
    }
    const badgeTargets = layout.seats.flatMap((seat) => [seat.name, seat.stack, seat.cards].filter((rect): rect is Rect => rect !== null));
    for (const badgeRect of badgeRects) {
      if (badgeRect === null) continue;
      for (const target of badgeTargets) {
        expect(intersects(badgeRect, target), "D/SB/BB badges must not cover names, stacks or hole cards").toBe(false);
      }
    }
    await expect(badge(page, 0, "D")).toHaveCount(1);
    await expect(badge(page, 1, "SB")).toHaveCount(1);
    await expect(badge(page, 2, "BB")).toHaveCount(1);
    await expect(page.locator('[data-seat="2"] [data-seat-badges]')).toHaveCount(1);
  });
}

test("跨手 Dealer 与盲注移动后座位映射保持完全一致", async ({ page }) => {
  const table = await installSeatTable(page, seatTableSnapshot({ playerCount: 6, viewerSeat: 0, dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2 }));
  await table.open();
  const before = await seatSlots(page);
  await expect(badge(page, 0, "D")).toHaveCount(1);
  await expect(badge(page, 1, "SB")).toHaveCount(1);
  await expect(badge(page, 2, "BB")).toHaveCount(1);

  table.event(
    { type: "HAND_STARTED", payload: { handNumber: 2, dealerSeat: 1, smallBlindSeat: 2, bigBlindSeat: 3, blindLevel: 0 } },
    { handId: "hand-2", handPhase: "PREFLOP", dealerSeat: 1, smallBlindSeat: 2, bigBlindSeat: 3, board: [], currentActorPlayerId: "player-5" },
  );
  await expect(badge(page, 1, "D")).toHaveCount(1);
  await expect(badge(page, 2, "SB")).toHaveCount(1);
  await expect(badge(page, 3, "BB")).toHaveCount(1);
  await expect(page.locator("[data-seat-badge]")).toHaveCount(3);
  expect(await seatSlots(page)).toEqual(before);
});
