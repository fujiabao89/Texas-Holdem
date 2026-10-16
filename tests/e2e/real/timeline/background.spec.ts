import { test, expect } from "./fixture";
import type { Page } from "@playwright/test";

async function coverWithNativeTab(page: Page) {
  const nativeVisibility = await page.context().newCDPSession(page);
  await nativeVisibility.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  const opened = page.waitForEvent("popup");
  await page.evaluate(() => {
    window.open("about:blank", "_blank");
  });
  const cover = await opened;
  const nativeCover = await cover.context().newCDPSession(cover);
  await nativeCover.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await cover.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState), {
      timeout: 5000,
      message: "native background visibility unavailable in this environment",
    })
    .toBe("hidden");
  return { cover, nativeVisibility, nativeCover };
}

test("R2/R3 真实窗口后台与恢复：不补播旧手，Snapshot回到当前可操作手 @timeline-rc", async ({
  timeline,
}) => {
  expect(process.env.TEX_TIMELINE_HEADED, "run headed (Linux: xvfb-run); no visibility mock").toBe(
    "1",
  );
  // Fail a missing native capability before starting a real room; never skip or
  // spoof visibility. Both this preflight and the actual table must become hidden.
  const page = await timeline.backgroundPage();
  const preflight = await coverWithNativeTab(page);
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
  await preflight.cover.close();
  await preflight.nativeCover.detach().catch(() => undefined);
  await preflight.nativeVisibility.detach();
  await timeline.create(6);
  const hidden = timeline.players[0]!;
  const { cover, nativeVisibility, nativeCover } = await coverWithNativeTab(hidden.page);
  hidden.suspendActions = true; // unavailable player uses the real server action timeout
  hidden.backgroundHands = new Set([hidden.game!.handId!]);
  await timeline.drive(1, "passive");
  await expect.poll(() => hidden.page.evaluate(() => document.visibilityState)).toBe("hidden");
  const beforeRestore = hidden.frames.length;
  await hidden.page.bringToFront();
  await expect.poll(() => hidden.page.evaluate(() => document.visibilityState)).toBe("visible");
  hidden.suspendActions = false;
  await expect
    .poll(
      () => hidden.frames.slice(beforeRestore).filter((frame) => frame.reason === "RESYNC").length,
    )
    .toBeGreaterThan(0);
  await expect(hidden.page.locator("[data-hand-id]")).toHaveAttribute(
    "data-hand-id",
    hidden.game!.handId!,
  );
  const coverVideo = cover.video();
  await cover.close();
  await coverVideo?.delete();
  await nativeCover.detach().catch(() => undefined);
  await nativeVisibility.detach();
  await timeline.drive(2, "fold");
  await timeline.assert();
});
