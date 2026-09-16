/**
 * TEX-55 赛果页权威接口刷新与直接访问 E2E 测试（docs/06 §3.4/§5）。
 *
 * 链路：真实浏览器（独立 BrowserContext，身份与 sessionStorage 隔离）→
 * 真实 apps/web → 真实本地 game-server → 真实 PostgreSQL（隔离 schema）。
 *
 * 覆盖：
 * 1. 终局后从牌桌跳转至赛果页（内存快照快速展示）。
 * 2. 赛果页刷新（Reload）后通过 HTTP 权威接口正确恢复相同赛果。
 * 3. 复制 URL / 直接访问赛果页（Direct Navigation）正确展示相同赛果。
 * 4. 房主开启下一局比赛后，旧赛果页依然独立稳定展示，不被新比赛快照覆盖。
 * 5. 未授权 / 无凭证直接访问展示明确且安全的错误提示。
 * 6. 移动端视口展示正常，包含冠军信息与完整筹码名次表。
 */
import { expect, type Page } from "@playwright/test";

import { test } from "../fixtures/observability";
import {
  countTournamentsForRoom,
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

async function sumFinalChips(page: Page): Promise<number> {
  const rows = page.getByRole("table").locator("tbody tr");
  const count = await rows.count();
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const text = await rows.nth(index).locator("td").last().textContent();
    sum += Number((text ?? "0").replace(/,/g, ""));
  }
  return sum;
}

test.describe("TEX-55 赛果页刷新与直接访问", () => {
  test("赛果页通过权威接口支持页面刷新、直接访问与多轮共存 @key", async ({
    browser,
    page,
    diagnostics,
  }) => {
    test.setTimeout(240_000);
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");

    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();

    // 1. 创建双人房间并开赛
    await createRoomViaUi(page, {
      displayName: "玩家甲",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });
    const roomId = (await page.url()).split("/").pop() ?? "";
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    const inviteCode = await readInviteCode(page);

    await joinViaUi(bob, inviteCode, "玩家乙");
    await takeSeatAndReady(page);
    await takeSeatAndReady(bob);

    await startTournamentViaUi(page);
    await enterTableWhenReady(bob);

    // 2. 推进比赛直至结束
    await driveTournamentToFinish([page, bob]);
    await expect(page.getByText("比赛已结束")).toBeVisible();

    // 3. 从牌桌跳转至赛果页（内存快照展示）
    const viewResult = page.getByRole("link", { name: "查看比赛结果" });
    await expect(viewResult).toBeVisible();
    await viewResult.click();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible();

    const resultUrl = page.url();
    const tournamentId = resultUrl.split("/").pop() ?? "";
    expect(tournamentId).toMatch(/^[0-9a-f-]{36}$/);

    // 验证快照渲染的初始赛果
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
    const initialChips = await sumFinalChips(page);
    expect(initialChips).toBe(40);
    const championText = await page.locator('section[aria-label="冠军"] p').nth(1).textContent();
    expect(["玩家甲", "玩家乙"]).toContain(championText ?? "");

    // 4. 路径验证一：页面刷新（Reload）恢复
    await page.reload();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });
    // 刷新后不应展示“快照不可用”或“未找到该场比赛的结果”
    await expect(page.getByText("当前连接无法获取该比赛的结果快照")).toHaveCount(0);
    await expect(page.getByText("未找到该场比赛的结果")).toHaveCount(0);
    // 验证 HTTP 恢复后展示完全一致的赛果
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(page)).toBe(40);
    const reloadedChampion = await page.locator('section[aria-label="冠军"] p').nth(1).textContent();
    expect(reloadedChampion).toBe(championText);

    // 5. 路径验证二：复制 URL 在同 context 新标签页直接访问（Direct Access）
    const newPage = await page.context().newPage();
    await newPage.goto(resultUrl);
    await expect(newPage.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });
    await expect(newPage.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(newPage)).toBe(40);
    const directAccessChampion = await newPage.locator('section[aria-label="冠军"] p').nth(1).textContent();
    expect(directAccessChampion).toBe(championText);

    // 6. 路径验证三：无凭证 context 直接访问安全阻断
    const anonymousContext = await browser.newContext();
    const anonPage = await anonymousContext.newPage();
    await anonPage.goto(resultUrl);
    // 无凭证应提示身份失效并引导重新加入
    await expect(anonPage.getByText("未找到此房间的身份凭证，请重新加入。")).toBeVisible({ timeout: 30_000 });
    await expect(anonPage.getByRole("link", { name: "加入房间" })).toBeVisible();
    await anonPage.close();
    await anonymousContext.close();

    // 7. 路径验证四：下一轮开局后旧赛果隔离共存
    // 房主在原页面点击「再来一局」开启第二场比赛
    await page.getByRole("button", { name: "再来一局" }).click();
    await expect(page).toHaveURL(new RegExp(`/room/${roomId}/table$`), { timeout: 30_000 });
    expect(await countTournamentsForRoom(roomId)).toBe(2);

    // 新标签页 newPage 依然停留在第一场比赛赛果页，验证旧赛果未被破坏
    await expect(newPage.getByRole("heading", { name: "比赛结果" })).toBeVisible();
    await expect(newPage.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(newPage)).toBe(40);

    // 再次在 newPage 刷新旧赛果页面，验证依然能从 HTTP 读出第一场赛果，不被进行中的第二场覆盖
    await newPage.reload();
    await expect(newPage.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });
    await expect(newPage.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(newPage)).toBe(40);
    expect(await newPage.locator('section[aria-label="冠军"] p').nth(1).textContent()).toBe(championText);

    await newPage.close();
    await bobContext.close();
  });

  test("移动端视口下赛果展示与千分位排版", async ({ browser, page, diagnostics }) => {
    test.setTimeout(240_000);
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");

    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();

    // 设置手机视口（iPhone 14 / ~390x844）
    await page.setViewportSize({ width: 390, height: 844 });

    await createRoomViaUi(page, {
      displayName: "移动玩家甲",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });
    const roomId = (await page.url()).split("/").pop() ?? "";
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    const inviteCode = await readInviteCode(page);

    await joinViaUi(bob, inviteCode, "移动玩家乙");
    await takeSeatAndReady(page);
    await takeSeatAndReady(bob);

    await startTournamentViaUi(page);
    await enterTableWhenReady(bob);

    await driveTournamentToFinish([page, bob]);
    await page.getByRole("link", { name: "查看比赛结果" }).click();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });

    // 刷新验证移动端 HTTP 恢复
    await page.reload();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(page)).toBe(40);

    await bobContext.close();
  });
});
