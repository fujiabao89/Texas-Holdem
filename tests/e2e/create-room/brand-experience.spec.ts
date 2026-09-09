import { expect, test } from "../fixtures/observability";
import { scanAxeViolations } from "../fixtures/a11y";
import { installTable, tableSnapshot } from "../animation-audio/table-fixture";

test("品牌首页可通过键盘打开选择并进入创建页", async ({ page }) => {
  await page.goto("/");
  const start = page.getByRole("button", { name: "开始一局", exact: true });
  await start.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "今晚，你来开桌？" });
  await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("link", { name: /创建房间/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByRole("heading", { name: "创建私人房间" })).toBeVisible();
  await expect(page.getByLabel("昵称")).toBeEditable();
  await expect(page.getByLabel("最大人数")).toBeVisible();
});

for (const width of [390, 1366]) {
  test(`品牌页面 ${width}px 不横向溢出且无严重可访问性问题`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/create", "/join?code=ABC234", "/settings"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // Read contrast and screenshots after the finite entrance animations finish.
      await page.locator(".rr-route-enter").evaluate(async (node) => {
        await Promise.all(
          node
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const violations = await scanAxeViolations(page, { minImpact: "serious" });
      expect(
        violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(
          `${route.split("?")[0].replaceAll("/", "") || "home"}-${width}.png`,
        ),
        fullPage: true,
      });
    }
  });
}

test("全站沿用减少动态效果偏好，邀请码仍只预填", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(
    await page.locator(".rr-route-enter").evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  await page.getByRole("link", { name: "我有邀请码" }).click();
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByLabel("昵称")).toHaveValue("");
  await page.goto("/join?code=ABC234");
  await expect(page.getByLabel("邀请码")).toHaveValue("ABC234");
  await page.goto("/settings");
  await page.getByRole("combobox", { name: "动态效果偏好" }).selectOption("reduce");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator(".rr-site")).toHaveAttribute("data-reduced-motion", "true");
  expect(
    await page.locator(".rr-route-enter").evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
});

test("历史抽屉约束键盘焦点，Esc 返回牌桌且不提交动作", async ({ page }) => {
  await page.route("**/api/v1/tournaments/*/hands?*", (route) =>
    route.fulfill({
      json: { data: { tournamentId: "tournament-38", items: [], nextCursor: null } },
    }),
  );
  const table = await installTable(page);
  await table.open();
  const opener = page.getByRole("button", { name: "牌局记录", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "牌局记录", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("还没有已归档的手牌。")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭", exact: true }).last()).toBeFocused();
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate(
        (node) => node.contains(document.activeElement) || document.activeElement === document.body,
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(table.commands.filter(({ type }) => type === "SUBMIT_ACTION")).toEqual([]);
});

test("赛果页按服务端排名展示冠军并适配手机", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const game = tableSnapshot(2, {
    tournamentStatus: "FINISHED",
    handPhase: "HAND_END",
    currentActorPlayerId: null,
    viewer: { ...tableSnapshot().viewer, legalActions: null },
    rankings: [
      { playerId: "player-1", placement: { from: 1, to: 1 }, displayOrder: 1 },
      { playerId: "player-2", placement: { from: 2, to: 2 }, displayOrder: 2 },
    ],
  });
  await installTable(page, game);
  await page.goto("/room/room-38/result/tournament-38");
  await expect(page.getByRole("heading", { name: "比赛结果", exact: true })).toBeVisible();
  const champion = page.getByRole("region", { name: "冠军", exact: true });
  await expect(champion).toContainText("玩家1");
  await page.locator(".rr-route-enter").evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await scanAxeViolations(page, { minImpact: "serious" })).map(({ id }) => id)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("result-mobile.png"), fullPage: true });
});
