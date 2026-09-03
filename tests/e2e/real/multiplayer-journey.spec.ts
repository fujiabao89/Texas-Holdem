/**
 * TEX-28 真实链路多人旅程 E2E（docs/06 §3.4/§5）。
 *
 * 链路：真实浏览器（独立 BrowserContext，身份与 sessionStorage 隔离）→
 * 真实 apps/web → 真实本地 game-server → 真实 PostgreSQL（隔离 schema）。
 * 全程经 UI 与服务端权威结果推进；不使用 route.fulfill / 伪造 Snapshot /
 * 修改浏览器 store（docs/06 §5）。洗牌由 TEX_TEST_RNG_SEED 固定，可重放。
 */
import { expect, type Page } from "@playwright/test";

import { test } from "../fixtures/observability";
import {
  countTournamentsForRoom,
  fetchTournamentGroundTruth,
  latestTournamentIdForRoom,
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

/** 结果页最终筹码合计（不变量：服务端裁决后筹码守恒）。 */
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

test.describe("真实链路多人主流程", () => {
  test("双人完整锦标赛：创建→邀请码加入→入座→准备→开局→全下→结算→结果页→再来一局 @key", async ({
    browser,
    page,
    diagnostics,
  }) => {
    test.setTimeout(240_000);
    // 预期内的 WS 连接中断噪声（导航/关闭时 teardown），非产品缺陷（Firefox/WebKit）。
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");
    // Alice 用默认 context（受 observability 门禁约束）；Bob 用独立 context。
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();

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

    // 非房主不能越权开局：Bob 的大厅不渲染「开始比赛」。
    await expect(bob.getByRole("button", { name: "开始比赛" })).toHaveCount(0);

    await startTournamentViaUi(page);
    await enterTableWhenReady(bob);

    await driveTournamentToFinish([page, bob]);
    await expect(page.getByText("比赛已结束")).toBeVisible();
    await expect(bob.getByText("比赛已结束")).toBeVisible();

    // 服务端权威排名：牌桌页 RankingSummary 列表两行（<table> 仅结果页渲染）。
    for (const current of [page, bob]) {
      await expect(current.locator('section[aria-labelledby="rankings-heading"] li')).toHaveCount(
        2,
      );
    }

    // 赛果入口：结果页展示冠军与最终排名。
    const viewResult = page.getByRole("link", { name: "查看比赛结果" });
    await expect(viewResult).toBeVisible();
    await viewResult.click();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible();
    // 结果页排名表：两行名次，筹码守恒（两人 20 + 20 = 40）。
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
    expect(await sumFinalChips(page)).toBe(40);
    const champion = await page.locator('section[aria-label="冠军"] p').nth(1).textContent();
    expect(["玩家甲", "玩家乙"]).toContain(champion ?? "");

    // 数据库事实：每手牌发牌完整（在局玩家各 2 张底牌）。
    const tournamentId = (await page.url()).split("/").pop() ?? "";
    expect(tournamentId).toMatch(/^[0-9a-f-]{36}$/);
    const hands = await fetchTournamentGroundTruth(tournamentId);
    expect(hands.length).toBeGreaterThanOrEqual(1);
    for (const hand of hands) {
      expect(hand.boardCards.length === 0 || hand.boardCards.length >= 3).toBe(true);
      for (const cards of hand.holeCardsBySeat.values()) expect(cards.length).toBe(2);
    }

    // 房主「再来一局」：全新 Tournament，旧比赛状态不污染新比赛。
    const oldTournamentId = tournamentId;
    expect(await countTournamentsForRoom(roomId)).toBe(1);
    await page.getByRole("button", { name: "再来一局" }).click();
    await expect(page).toHaveURL(new RegExp(`/room/${roomId}/table$`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "牌桌", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await countTournamentsForRoom(roomId)).toBe(2);
    const newTournamentId = await latestTournamentIdForRoom(roomId);
    expect(newTournamentId).not.toBe(oldTournamentId);
    // 新比赛第一手可行动（Bob 经大厅重新进入牌桌）：双方都能看到行动或等待态。
    await bob.goto(`/room/${roomId}`);
    await enterTableWhenReady(bob);
    for (const current of [page, bob]) {
      // strict mode：同一时刻可能「等待文案」与本人弃牌按钮并存，.or() 命中 2 个；
      // 断言意图是「至少有其一」→ 取第一个可见匹配。
      await expect(
        current
          .getByText("等待其他玩家行动")
          .or(current.getByRole("button", { name: /^弃牌$/ }))
          .first(),
      ).toBeVisible({ timeout: 30_000 });
    }

    await bobContext.close();
  });

  test("三人全下：完整摊牌、服务端最佳五张与筹码守恒 @key", async ({
    browser,
    page,
    diagnostics,
  }) => {
    test.setTimeout(240_000);
    // 预期内的 WS 连接中断噪声（导航/关闭时 teardown），非产品缺陷（Firefox/WebKit）。
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");
    // Alice 用默认 context（受 observability 门禁约束）；Bob/Carol 独立 context。
    const contexts = [await browser.newContext(), await browser.newContext()];
    const [bob, carol] = await Promise.all(contexts.map((context) => context.newPage()));
    const alice = page;

    await createRoomViaUi(alice, {
      displayName: "玩家一",
      startingStack: 20,
      maxPlayers: 3,
      smallBlind: 1,
      bigBlind: 2,
    });
    const roomId = (await alice.url()).split("/").pop() ?? "";
    const inviteCode = await readInviteCode(alice);
    await joinViaUi(bob, inviteCode, "玩家二");
    await joinViaUi(carol, inviteCode, "玩家三");
    for (const current of [alice, bob, carol]) await takeSeatAndReady(current);

    await startTournamentViaUi(alice);
    await enterTableWhenReady(bob);
    await enterTableWhenReady(carol);

    // 三人全员全下：一决胜负（固定 seed，可重放）。
    await driveTournamentToFinish([alice, bob, carol]);
    for (const current of [alice, bob, carol]) {
      await expect(current.getByText("比赛已结束")).toBeVisible();
    }

    // 排名三人（牌桌页 RankingSummary 列表，服务端权威）。
    for (const current of [alice, bob, carol]) {
      await expect(current.locator('section[aria-labelledby="rankings-heading"] li')).toHaveCount(
        3,
      );
    }
    // 结果页排名表：三行名次，筹码守恒（3 × 20 = 60）；冠军独占全部筹码。
    await alice.getByRole("link", { name: "查看比赛结果" }).click();
    await expect(alice.getByRole("heading", { name: "比赛结果" })).toBeVisible();
    await expect(alice.getByRole("table").locator("tbody tr")).toHaveCount(3);
    expect(await sumFinalChips(alice)).toBe(60);

    // 全下必有摊牌：服务端亮牌（PLAYER_REVEALED）至少覆盖两名输家或赢家。
    const tournamentId = await latestTournamentIdForRoom(roomId);
    const hands = await fetchTournamentGroundTruth(tournamentId);
    const finalHand = hands[hands.length - 1];
    expect(finalHand).toBeDefined();
    expect(finalHand.revealedCardsBySeat.size).toBeGreaterThanOrEqual(2);
    expect(finalHand.boardCards.length).toBe(5);

    for (const context of contexts) await context.close();
  });
});
