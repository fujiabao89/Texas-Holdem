import type { Locator } from "@playwright/test";

import { animationTimings } from "../../../apps/web/src/animations/timings";
import { message } from "../../../apps/web/src/messages/zh-CN";
import { PRESENTATION_STORAGE_KEYS } from "../../../apps/web/src/state/presentation-preferences";
import { scanAxeViolations } from "../fixtures/a11y";
import { expect, test } from "../fixtures/observability";
import { audioProbe, board, captureTableEvidence, freezeClock, installAudioProbe, installTable, reveal, setVisibility, tableSnapshot } from "./table-fixture";

test("TEX-38 键盘调整音量和动态效果，刷新与牌桌音效开关共用持久偏好", async ({ page }, testInfo) => {
  const table = await installTable(page);
  await installAudioProbe(page);
  // SSR always renders the default enabled value. Waiting for the persisted
  // disabled value therefore proves that client hydration and event handlers
  // are ready before this keyboard-only interaction starts.
  await page.addInitScript(
    ({ soundEnabledKey, seededKey }) => {
      if (sessionStorage.getItem(seededKey) === "1") return;
      localStorage.setItem(soundEnabledKey, "0");
      sessionStorage.setItem(seededKey, "1");
    },
    {
      soundEnabledKey: PRESENTATION_STORAGE_KEYS.soundEnabled,
      seededKey: "texas-holdem:e2e:settings-sound-seeded",
    },
  );
  await page.goto("/settings");
  const sound = page.getByRole("switch", { name: message("settings.soundSwitchLabel") });
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await sound.press("Space");
  await expect(sound).toHaveAttribute("aria-checked", "true");
  const volume = page.getByRole("slider", { name: message("settings.volumeLabel") });
  await volume.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(volume).toHaveValue("1");
  const motion = page.getByRole("combobox", { name: message("settings.motionLabel") });
  await motion.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(motion).toHaveValue("reduce");
  await page.reload();
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await expect(volume).toHaveValue("1");
  await expect(motion).toHaveValue("reduce");
  expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
  await captureTableEvidence(page, testInfo, "settings");
  await table.open();
  const tableSound = page.getByRole("button", { name: message("table.soundLabel") });
  await expect(tableSound).toHaveAttribute("aria-pressed", "true");
  await tableSound.focus();
  await page.keyboard.press("Enter");
  await expect(tableSound).toHaveAttribute("aria-pressed", "false");
  await page.goto("/settings");
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect(volume).toHaveValue("1");
  expect(table.commands.filter(({ type }) => type === "SUBMIT_ACTION")).toEqual([]);
});

for (const failure of ["autoplay", "play", "load"] as const) {
  test(`TEX-38 音频 ${failure} 失败不阻断动画、权威事件和键盘下注`, async ({ page }) => {
    await freezeClock(page);
    await installAudioProbe(page, failure);
    const table = await installTable(page);
    await table.open();
    await page.keyboard.press("Tab");
    table.event({ type: "PLAYER_BET", payload: { playerId: "player-2", seat: 1, source: "HUMAN_SOCKET", amount: 5, betTo: 15 } });
    await page.clock.runFor(animationTimings.wager + 1);
    const call = page.getByRole("button", { name: "跟注 5" });
    await expect(call).toBeEnabled();
    await call.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => table.commands.filter(({ type }) => type === "SUBMIT_ACTION").length).toBe(1);
    expect(table.commands.find(({ type }) => type === "SUBMIT_ACTION")).toMatchObject({ payload: { expectedSequence: "2", action: { type: "CALL" } } });
    const probe = await audioProbe(page);
    if (failure === "play") expect(probe.played).toContain("/audio/kenney-casino-chip-bet.mp3");
    if (failure === "load") expect(probe.constructions).toContain("/audio/kenney-casino-chip-bet.mp3");
    if (failure === "autoplay") expect(probe.played).toEqual([]);
  });
}

test("TEX-38 公共牌依次到达终帧，连续摊牌各自重新呈现服务端最佳五张", async ({ page }) => {
  await freezeClock(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAudioProbe(page);
  const table = await installTable(page);
  await table.open();
  table.event({ type: "FLOP_DEALT", payload: { cards: board.slice(0, 3) } }, { board: board.slice(0, 3), handPhase: "FLOP" });
  await expect(page.locator(".board-deal-flight")).toHaveCount(3);
  await page.clock.runFor(animationTimings.flopCard * 3 + animationTimings.flopInterval * 2 + 1);
  await expect(page.locator(".board-deal-flight")).toHaveCount(0);
  table.event({ type: "TURN_DEALT", payload: { card: board[3]! } }, { board: board.slice(0, 4), handPhase: "TURN" });
  await expect(page.locator(".board-deal-flight")).toHaveCount(1);
  await page.clock.runFor(animationTimings.turnRiver + 1);
  table.event({ type: "RIVER_DEALT", payload: { card: board[4]! } }, { board, handPhase: "RIVER" });
  await expect(page.locator(".board-deal-flight")).toHaveCount(1);
  await page.clock.runFor(animationTimings.turnRiver + 1);
  const boardRegion = page.locator(`[aria-label="${message("table.board")}"]`);
  await expect(boardRegion.getByRole("img")).toHaveCount(5);
  const first = reveal("player-1");
  table.event(first, { players: [{ playerId: "player-1", revealedCards: first.payload.cards }] });
  const showcase = page.locator(".showdown-showcase");
  await expect(showcase).toContainText("玩家1");
  const previous = await showcase.elementHandle();
  expect(previous).not.toBeNull();
  const second = reveal("player-2");
  table.event(second, { players: [{ playerId: "player-2", revealedCards: second.payload.cards }] });
  await page.clock.runFor(animationTimings.showdownReveal + animationTimings.bestFive + 1);
  await expect(showcase).toContainText("玩家2");
  expect(await previous!.evaluate((node) => node.isConnected)).toBe(false);
  await expect(showcase.locator(".showdown-best-card")).toHaveCount(5);
  const projectedCards = await showcase.locator(".showdown-best-card [role=img]").evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label")));
  expect(projectedCards).toEqual(await boardRegion.getByRole("img").evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label"))));
});

async function expectReadableCardFaces(cards: Locator): Promise<void> {
  const problems = await cards.evaluateAll((faces) => faces.flatMap((face) => {
    const bounds = face.getBoundingClientRect();
    // Check rendered text bounds rather than requiring a particular card markup.
    const glyphs = Array.from(face.querySelectorAll("span"))
      .filter((node) => node.children.length === 0 && node.textContent?.trim())
      .map((node) => ({ text: node.textContent, rect: node.getBoundingClientRect() }));
    const errors: string[] = [];
    if (glyphs.length < 2) errors.push("missing rank or suit");
    for (const [index, glyph] of glyphs.entries()) {
      const rect = glyph.rect;
      if (rect.width <= 0 || rect.height <= 0 || rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5 || rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5) {
        errors.push(`${glyph.text} is clipped`);
      }
      for (const other of glyphs.slice(index + 1)) {
        if (Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 0.5 && Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 0.5) {
          errors.push(`${glyph.text} overlaps ${other.text}`);
        }
      }
    }
    return errors.map((error) => `${face.getAttribute("aria-label")}: ${error}`);
  }));
  expect(problems, "Small card ranks and suits must remain separate and inside the face").toEqual([]);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`TEX-46 小牌 ${viewport.width}x${viewport.height} 摊牌与结算牌面不重叠`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await freezeClock(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await installAudioProbe(page);
    const table = await installTable(page, tableSnapshot(2, { board, handPhase: "RIVER" }));
    await table.open();
    await expectReadableCardFaces(page.locator('[data-card-variant="board"][role="img"]'));
    await expectReadableCardFaces(page.locator('[data-card-variant="hole"][role="img"]'));
    const event = reveal("player-2");
    event.payload.cards = [{ rank: "A", suit: "HEARTS" }, { rank: "K", suit: "DIAMONDS" }];
    table.event(event, { players: [{ playerId: "player-2", revealedCards: event.payload.cards }] });
    const showcase = page.locator(".showdown-showcase");
    await expect(showcase.getByRole("img")).toHaveCount(12);
    await page.clock.runFor(4_000);
    await expectReadableCardFaces(showcase.getByRole("img"));
    await captureTableEvidence(page, testInfo, `compact-showdown-${viewport.width}`);
    // CSS animations use the browser timeline, not Playwright's mocked JS clock.
    // Finish them only for this evidence image so the best-five row is visible.
    const bestFivePath = testInfo.outputPath(`compact-best-five-${viewport.width}.png`);
    await page.screenshot({ path: bestFivePath, fullPage: true, animations: "disabled" });
    await testInfo.attach("compact-best-five", { path: bestFivePath, contentType: "image/png" });
    await page.clock.runFor(animationTimings.showdownReveal + animationTimings.bestFive - 4_000 + 1);
    await expect(showcase).toHaveCount(0);
    const outcome = page.getByRole("region", { name: message("table.feedback.handOutcome") });
    await expect(outcome.getByRole("img")).toHaveCount(5);
    await expectReadableCardFaces(outcome.getByRole("img"));
    const opponentCards = page.locator('[data-viewer="false"] [data-card-variant="seat"][role="img"]');
    await expect(opponentCards).toHaveCount(2);
    await expectReadableCardFaces(opponentCards);
    await captureTableEvidence(page, testInfo, `compact-outcome-${viewport.width}`);
  });
}

test("TEX-38 减少动态效果仍保留公开牌型、最佳五张和逐池分配", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installAudioProbe(page);
  const table = await installTable(page, tableSnapshot(3, { board, handPhase: "RIVER" }));
  await table.open();
  for (const player of ["player-1", "player-2"] as const) {
    const event = reveal(player);
    table.event(event, { players: [{ playerId: player, revealedCards: event.payload.cards }] });
  }
  table.event({ type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 100, awards: [{ playerId: "player-1", amount: 50 }, { playerId: "player-2", amount: 50 }], winningHandRank: reveal("player-1").payload.handRank } });
  table.event({ type: "POT_AWARDED", payload: { potIndex: 1, potAmount: 60, awards: [{ playerId: "player-2", amount: 60 }], winningHandRank: reveal("player-2").payload.handRank } });
  const result = page.getByRole("region", { name: message("table.feedback.handOutcome") });
  await expect(result).toBeVisible();
  await expect(result).toContainText("同花顺");
  await expect(result).toContainText("主池");
  await expect(result).toContainText("100");
  await expect(result).toContainText("边池 1");
  await expect(result).toContainText("60");
  await expect(result).toContainText("玩家1 获得 50");
  await expect(result).toContainText("玩家2 获得 50");
  await expect(result).toContainText("玩家2 获得 60");
  await expect(result.getByRole("img")).toHaveCount(10);
  await expect(page.locator(".showdown-showcase, .board-deal-flight")).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().filter((animation) =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity,
  ).length)).toBe(0);
  await expect(page.getByRole("button", { name: "跟注 5" })).toBeEnabled();
  expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
  await captureTableEvidence(page, testInfo, "reduced-motion-outcome");
});

test("TEX-38 后台丢弃旧动画音效，返回请求 Snapshot 并从新事件继续", async ({ page }) => {
  await freezeClock(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAudioProbe(page);
  const table = await installTable(page);
  await table.open();
  await page.keyboard.press("Tab");
  table.event({ type: "FLOP_DEALT", payload: { cards: board.slice(0, 3) } }, { board: board.slice(0, 3), handPhase: "FLOP" });
  await expect(page.locator(".board-deal-flight")).toHaveCount(3);
  await setVisibility(page, "hidden");
  table.event({ type: "TURN_DEALT", payload: { card: board[3]! } }, { board: board.slice(0, 4), handPhase: "TURN" });
  await page.clock.runFor(5_000);
  await expect(page.locator(".board-deal-flight")).toHaveCount(0);
  expect((await audioProbe(page)).played).toEqual([]);
  await setVisibility(page, "visible");
  await expect.poll(() => table.commands.filter(({ type }) => type === "REQUEST_SNAPSHOT").length).toBe(1);
  await expect(page.getByRole("button", { name: "跟注 5" })).toBeEnabled();
  await page.clock.runFor(2_000);
  expect((await audioProbe(page)).played).toEqual([]);
  table.event({ type: "RIVER_DEALT", payload: { card: board[4]! } }, { board, handPhase: "RIVER" });
  await expect(page.locator(".board-deal-flight")).toHaveCount(1);
  await page.clock.runFor(animationTimings.turnRiver + 1);
  expect((await audioProbe(page)).played).toEqual(["/audio/kenney-casino-board-soft.mp3"]);
  await expect(page.locator(`[aria-label="${message("table.board")}"]`).getByRole("img")).toHaveCount(5);
});

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 1366, height: 900 }]) {
  test(`TEX-38 十人桌 ${viewport.width}px 无横向溢出且下注可操作`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installAudioProbe(page);
    const table = await installTable(page, tableSnapshot(10));
    await table.open();
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      seats: Array.from(document.querySelectorAll("[data-seat]")).map((seat) => {
        const rect = seat.getBoundingClientRect();
        return { name: seat.getAttribute("aria-label"), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    }));
    await captureTableEvidence(page, testInfo, `table-${viewport.width}`);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    for (const seat of layout.seats) {
      expect(seat.left).toBeGreaterThanOrEqual(0);
      expect(seat.right).toBeLessThanOrEqual(layout.viewportWidth);
    }
    const overlappingSeats = layout.seats.flatMap((seat, index) => layout.seats.slice(index + 1)
      .filter((other) => seat.left < other.right && seat.right > other.left && seat.top < other.bottom && seat.bottom > other.top)
      .map((other) => `${seat.name} intersects ${other.name}`));
    expect(overlappingSeats, "Ten-player seat cards, names, stacks and bets must remain distinct").toEqual([]);
    const call = page.getByRole("button", { name: "跟注 5" });
    await call.click();
    await expect.poll(() => table.commands.filter(({ type }) => type === "SUBMIT_ACTION").length).toBe(1);
    expect(table.commands.find(({ type }) => type === "SUBMIT_ACTION")).toMatchObject({ payload: { expectedSequence: "1", action: { type: "CALL" } } });
  });
}

test("TEX-38 6x CPU 限速时动画期间仍可下注并记录实际帧间隔", async ({ page, browserName }, testInfo) => {
  // Collect 90 real frames under CPU throttling plus trace/video overhead.
  // The default whole-test deadline is not a product input-latency budget.
  test.setTimeout(60_000);
  test.skip(browserName !== "chromium", "CPU throttling requires the Chromium CDP API");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAudioProbe(page);
  const table = await installTable(page, tableSnapshot(10));
  // This test measures in-hand animation/input, not dev-server cold hydration.
  await table.open();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  try {
    // Observe real browser frame timestamps; do not stub requestAnimationFrame
    // or force the product's FrameHealth state to make degradation pass.
    const frameSample = page.evaluate(() => new Promise<number[]>((resolve) => {
      const intervals: number[] = [];
      let previous: number | undefined;
      const sample = (now: number) => {
        if (previous !== undefined) intervals.push(now - previous);
        previous = now;
        if (intervals.length === 90) resolve(intervals);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    // Observe the transient DOM state before sending the event. Cross-process
    // polling can miss an entire flight under CPU contention even when it ran.
    // This observer only reads the DOM; it never forces product frame health.
    const animationObservation = await page.locator("main[data-reduced-motion]").evaluateHandle((tableNode) => {
      const observed = new Promise<boolean>((resolve) => {
        const observer = new MutationObserver(check);
        const timeout = window.setTimeout(() => { observer.disconnect(); resolve(false); }, 5_000);
        function check() {
          if (tableNode.querySelectorAll(".board-deal-flight").length === 3 || tableNode.getAttribute("data-reduced-motion") === "true") {
            observer.disconnect();
            window.clearTimeout(timeout);
            resolve(true);
          }
        }
        observer.observe(tableNode, { attributes: true, childList: true, subtree: true });
        check();
      });
      return { observed };
    });
    table.event({ type: "FLOP_DEALT", payload: { cards: board.slice(0, 3) } }, { board: board.slice(0, 3), handPhase: "FLOP" });
    try {
      expect(await animationObservation.evaluate(({ observed }) => observed)).toBe(true);
    } finally {
      await animationObservation.dispose();
    }
    const started = performance.now();
    await page.getByRole("button", { name: "跟注 5" }).click();
    await expect.poll(() => table.commands.filter(({ type }) => type === "SUBMIT_ACTION").length).toBe(1);
    const automationToCommandMs = performance.now() - started;
    expect(table.commands.find(({ type }) => type === "SUBMIT_ACTION")).toMatchObject({ payload: { expectedSequence: "2", action: { type: "CALL" } } });
    await expect(page.locator(".board-deal-flight")).toHaveCount(0);
    await expect(page.locator(`[aria-label="${message("table.board")}"]`).getByRole("img")).toHaveCount(3);
    const intervals = await frameSample;
    const sorted = [...intervals].sort((a, b) => a - b);
    const report = {
      browser: page.context().browser()?.version(), viewport: page.viewportSize(), cpuSlowdownRate: 6,
      samples: intervals.length, frameIntervalMeanMs: intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length,
      frameIntervalP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], slowFramesOver34Ms: intervals.filter((interval) => interval > 34).length,
      automationToCommandMs,
      automaticReducedMotion: await page.locator("main[data-reduced-motion]").getAttribute("data-reduced-motion"),
      boundary: "Chromium desktop CDP simulation; frame intervals are observed, not a real-device FPS certification. Command duration includes Playwright automation overhead.",
    };
    await testInfo.attach("TEX-38-cpu-6x", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(`[TEX-38-CPU-6X] ${JSON.stringify(report)}`);
    await captureTableEvidence(page, testInfo, "cpu-6x");
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
});
