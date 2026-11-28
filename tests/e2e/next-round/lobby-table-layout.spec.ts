import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/observability";
import { scanAxeViolations } from "../fixtures/a11y";
import { nextRoundFixture } from "./lobby-fixture";
import type { RoomSnapshot } from "../../../packages/protocol/src";

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function overlaps(a: Box, b: Box, tolerance = 1): boolean {
  return a.left + tolerance < b.right && a.right - tolerance > b.left && a.top + tolerance < b.bottom && a.bottom - tolerance > b.top;
}

function fullReadyPlayers(count: number): RoomSnapshot["players"] {
  return Array.from({ length: count }, (_, seat) => ({
    playerId: `player-${seat + 1}`,
    displayName: `牌友${seat + 1}号玩家`,
    seat,
    ready: true,
    connectionStatus: "CONNECTED" as const,
    pokerStatus: "ACTIVE" as const,
  }));
}

async function measureBoxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }),
  );
}

for (const maxPlayers of [2, 6, 10] as const) {
  test(`TEX-68 桌面端 ${maxPlayers}/${maxPlayers} 满座全员准备零重叠且无障碍通过`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = nextRoundFixture();
    fixture.change({
      status: "LOBBY",
      inviteCode: "ABC234",
      config: { ...fixture.snapshot().config, maxPlayers },
      players: fullReadyPlayers(maxPlayers),
    });
    await fixture.install(page);
    await page.goto("/room/room-49");

    await expect(page.locator(".lobby-seat-card")).toHaveCount(maxPlayers);
    await expect(page.locator(".lobby-ready-chip")).toHaveCount(maxPlayers);

    const cards = await measureBoxes(page, ".lobby-seat-card");
    const chips = await measureBoxes(page, ".lobby-ready-chip");
    const [plaque] = await measureBoxes(page, ".lobby-plaque");
    const [felt] = await measureBoxes(page, ".lobby-felt");
    expect(plaque).toBeDefined();
    expect(felt).toBeDefined();

    // Desktop plaque sits centered inside the green felt with zero collision against seats or chips.
    expect(plaque!.left).toBeGreaterThanOrEqual(felt!.left);
    expect(plaque!.right).toBeLessThanOrEqual(felt!.right);
    expect(plaque!.top).toBeGreaterThanOrEqual(felt!.top);
    expect(plaque!.bottom).toBeLessThanOrEqual(felt!.bottom);

    for (let i = 0; i < maxPlayers; i += 1) {
      // Ready chip must never overlap its OWN seat card!
      expect(overlaps(chips[i]!, cards[i]!, 0)).toBe(false);
      expect(overlaps(cards[i]!, plaque!)).toBe(false);
      expect(overlaps(chips[i]!, plaque!)).toBe(false);
      for (let j = i + 1; j < maxPlayers; j += 1) {
        expect(overlaps(cards[i]!, cards[j]!)).toBe(false);
        expect(overlaps(chips[i]!, chips[j]!)).toBe(false);
        expect(overlaps(chips[i]!, cards[j]!)).toBe(false);
        expect(overlaps(chips[j]!, cards[i]!)).toBe(false);
      }
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (maxPlayers === 10) {
      expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
    }
  });

  test(`TEX-68 手机竖屏 375px ${maxPlayers}/${maxPlayers} 满座全员准备零重叠零裁切`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = nextRoundFixture();
    fixture.change({
      status: "LOBBY",
      inviteCode: "ABC234",
      config: { ...fixture.snapshot().config, maxPlayers },
      players: fullReadyPlayers(maxPlayers),
    });
    await fixture.install(page);
    await page.goto("/room/room-49");

    await expect(page.locator(".lobby-seat-card")).toHaveCount(maxPlayers);
    await expect(page.locator(".lobby-ready-chip")).toHaveCount(maxPlayers);

    const cards = await measureBoxes(page, ".lobby-seat-card");
    const chips = await measureBoxes(page, ".lobby-ready-chip");
    const [plaque] = await measureBoxes(page, ".lobby-plaque");
    const [felt] = await measureBoxes(page, ".lobby-felt");
    const [watermark] = await measureBoxes(page, ".lobby-felt-watermark");

    // Portrait oval: taller than wide, plaque sits cleanly above the felt, watermark sits inside.
    expect(felt!.height).toBeGreaterThan(felt!.width);
    expect(plaque!.bottom).toBeLessThanOrEqual(felt!.top);
    expect(watermark!.width).toBeGreaterThan(0);

    for (let i = 0; i < maxPlayers; i += 1) {
      // Ready chip must never overlap its OWN seat card!
      expect(overlaps(chips[i]!, cards[i]!, 0)).toBe(false);
      // Zero horizontal clipping at 375px.
      expect(cards[i]!.left).toBeGreaterThanOrEqual(0);
      expect(cards[i]!.right).toBeLessThanOrEqual(375);
      expect(chips[i]!.left).toBeGreaterThanOrEqual(0);
      expect(chips[i]!.right).toBeLessThanOrEqual(375);
      expect(overlaps(cards[i]!, watermark!)).toBe(false);
      expect(overlaps(chips[i]!, watermark!)).toBe(false);
      for (let j = i + 1; j < maxPlayers; j += 1) {
        expect(overlaps(cards[i]!, cards[j]!)).toBe(false);
        expect(overlaps(chips[i]!, chips[j]!)).toBe(false);
        expect(overlaps(chips[i]!, cards[j]!)).toBe(false);
        expect(overlaps(chips[j]!, cards[i]!)).toBe(false);
      }
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (maxPlayers === 10) {
      expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
    }
  });
}

test("TEX-68 实体桌盘选座、离座、随机入座、准备筹码与折叠规则编辑", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fixture = nextRoundFixture();
  fixture.change({
    status: "LOBBY",
    inviteCode: "ABC234",
    config: { ...fixture.snapshot().config, maxPlayers: 6 },
    players: [
      { playerId: "player-1", displayName: "房主甲", seat: null, ready: false, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
      { playerId: "player-2", displayName: "牌友乙", seat: 1, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" },
    ],
  });
  await fixture.install(page);
  await page.route(/\/api\/v1\/rooms\/room-49$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body?.operation?.type === "UPDATE_CONFIG") {
      fixture.change({ config: body.operation.config });
      await route.fulfill({ json: { data: { roomSnapshot: fixture.snapshot() } } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/room/room-49");

  // Structure card is read-only by default; host expands it with "编辑规则".
  await expect(page.getByRole("button", { name: "保存房间配置" })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑规则" }).click();
  await page.getByLabel("初始筹码").fill("2500");
  await page.getByRole("button", { name: "保存房间配置" }).click();
  await expect(page.locator(".lobby-structure-grid")).toContainText("2,500");
  await expect(page.getByRole("button", { name: "保存房间配置" })).toHaveCount(0);

  // Select empty seat 4, then leave seat, then random seat, then ready.
  await page.getByRole("button", { name: "选择此座位（座位 4）" }).click();
  await expect(page.locator("[data-lobby-seat='3'] .lobby-seat-card[data-self='true']")).toBeVisible();
  await page.getByRole("button", { name: "离开座位" }).click();
  await expect(page.getByRole("button", { name: "准备", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "随机入座" }).click();
  await expect(page.locator("[data-lobby-seat='0'] .lobby-seat-card[data-self='true']")).toBeVisible();

  // Ready adds the gilded chip and unlocks start.
  await page.getByRole("button", { name: "准备", exact: true }).click();
  await expect(page.locator("[data-lobby-seat='0'] .lobby-ready-chip")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始比赛" })).toBeEnabled();
});
