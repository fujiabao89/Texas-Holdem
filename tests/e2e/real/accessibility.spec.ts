/**
 * TEX-28 真实链路无障碍测试（docs/05 §16、docs/06 §8）。
 *
 * 在真实浏览器 → 真实 web → 真实 game-server 链路上验证：
 * 1. 纯键盘完成创建/加入/入座/准备/开局/全下主流程（focus + 键盘事件，
 *    无鼠标点击）；
 * 2. axe-core 扫描关键页面（首页/创建/大厅/牌桌行动态/结果页）：
 *    门槛为 critical+serious 违规为零；本断言不宣称完整 WCAG 2.2 AA
 *    通过——moderate/minor 与需人工判断的项（对比度实测、缩放、听感）
 *    见 docs/06 §8 的边界说明；
 * 3. 关键状态区使用 aria-live（连接状态/等待提示），屏幕阅读器可感知；
 * 4. Reduced Motion 下跳过运动动画，业务结果（排名/筹码守恒）不变。
 */
import { expect } from "@playwright/test";

import { scanAxeViolations } from "../fixtures/a11y";
import { test } from "../fixtures/observability";
import {
  createRoomViaUi,
  driveTournamentToFinish,
  enterTableWhenReady,
  joinViaUi,
  readInviteCode,
  startTournamentViaUi,
  takeSeatAndReady,
} from "./support/ui";

/** 纯键盘聚焦并激活（等价键盘用户操作，无鼠标）。 */
async function pressOn(
  page: { keyboard: import("@playwright/test").Keyboard },
  locator: import("@playwright/test").Locator,
  key = "Enter",
): Promise<void> {
  await locator.focus();
  await page.keyboard.press(key);
}

test.describe("真实链路无障碍", () => {
  test("纯键盘主流程与关键页面 axe 扫描 @key", async ({ browser, page, diagnostics }) => {
    test.setTimeout(240_000);
    // 预期内的 WS 连接中断噪声（导航/关闭时 teardown），非产品缺陷（Firefox/WebKit）。
    diagnostics.allow(/can't establish a connection/);
    diagnostics.allow("WebSocket is closed before the connection is established");
    // 首页/创建页：键盘填写表单并提交（昵称 autoFocus，Tab 序自然覆盖全部字段）。
    await page.goto("/");
    await expect(
      page
        .getByRole("heading", { name: "德州扑克" })
        .or(page.getByRole("heading", { name: "首页" })),
    ).toBeVisible();
    expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);

    await page.goto("/create");
    await expect(page.getByRole("heading", { name: "创建私人房间" })).toBeVisible();
    expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);

    await page.getByLabel("昵称").focus();
    await page.keyboard.type("玩家甲");
    await page.keyboard.press("Tab"); // 最大人数
    await page.keyboard.press("Control+a");
    await page.keyboard.type("2");
    await page.keyboard.press("Tab"); // 初始筹码
    await page.keyboard.press("Control+a");
    await page.keyboard.type("20");
    await page.keyboard.press("Tab"); // 小盲注（默认 50 对筹码 20 是退化配置，必须显式降低）
    await page.keyboard.press("Control+a");
    await page.keyboard.type("1");
    await page.keyboard.press("Tab"); // 大盲注
    await page.keyboard.press("Control+a");
    await page.keyboard.type("2");
    // 跳过 行动时间/延时储备（默认值合法）。
    for (let index = 0; index < 3; index += 1) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter"); // 创建并进入大厅
    await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible({ timeout: 30_000 });

    // Bob 纯键盘加入（join?code 预填邀请码）。
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    const inviteCode = await readInviteCode(page);
    await bob.goto(`/join?code=${inviteCode}`);
    await bob.getByLabel("昵称").focus();
    await bob.keyboard.type("玩家乙");
    await bob.keyboard.press("Tab"); // 加入房间
    await bob.keyboard.press("Enter");
    await expect(bob.getByRole("heading", { name: "房间大厅" })).toBeVisible({ timeout: 30_000 });

    // 先等待双方连接就绪，再入座/准备：SET_READY 需经已认证 WS 提交，早于
    // CONNECTED 按准备会被客户端丢弃（allReady 不满足则开局按钮禁用、流程卡死）。
    const connected = page.getByText("已连接").first();
    await expect(connected).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByText("已连接").first()).toBeVisible({ timeout: 15_000 });

    // 双方纯键盘入座并准备。
    await pressOn(page, page.getByRole("button", { name: "选择此座位" }).first());
    const bobSeat = bob.getByRole("button", { name: "选择此座位" }).first();
    await expect(bobSeat).toBeVisible({ timeout: 15_000 });
    await pressOn(bob, bobSeat);
    const readyAlice = page.getByRole("button", { name: "准备", exact: true });
    const readyBob = bob.getByRole("button", { name: "准备", exact: true });
    await expect(readyAlice).toBeVisible({ timeout: 15_000 });
    await expect(readyBob).toBeVisible({ timeout: 15_000 });
    await pressOn(page, readyAlice);
    await pressOn(bob, readyBob);

    // 大厅：连接状态用 aria-live 播报；axe 扫描。
    expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);

    // 开局按钮只在双方入座且 Ready 后启用：以 enable 作为双方命令落地的确定等待点。
    const start = page.getByRole("button", { name: "开始比赛" });
    await expect(start).toBeEnabled({ timeout: 15_000 });
    // 房主纯键盘开局。
    await pressOn(page, start);
    const enterTable = page.getByRole("link", { name: "进入牌桌" });
    await expect(enterTable).toBeVisible({ timeout: 30_000 });
    await pressOn(page, enterTable);
    await expect(page.getByRole("heading", { name: "牌桌", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await enterTableWhenReady(bob);

    // 牌桌行动态：等待可操作按钮，纯键盘全下 + 二次确认；此时扫描牌桌。
    const allIn = page.getByRole("button", { name: /^全下至 \d+$/ }).first();
    await expect(allIn).toBeVisible({ timeout: 60_000 });
    expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
    // 等待提示区 aria-live（等待他人或行动中状态可被屏幕阅读器感知）。
    expect(await page.getByRole("status").count()).toBeGreaterThan(0);
    await pressOn(page, allIn);
    const confirm = page.getByRole("button", { name: /^再次点击确认全下至 \d+$/ }).first();
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await pressOn(page, confirm);

    // 完成比赛后扫描结果页。
    await driveTournamentToFinish([page, bob]);
    await expect(page.getByText("比赛已结束")).toBeVisible();
    const viewResult = page.getByRole("link", { name: "查看比赛结果" });
    await expect(viewResult).toBeVisible();
    await viewResult.click();
    await expect(page.getByRole("heading", { name: "比赛结果" })).toBeVisible({ timeout: 30_000 });
    expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);

    await bobContext.close();
  });

  test("Reduced Motion：跳过运动动画，业务结果不变", async ({ browser }) => {
    test.setTimeout(240_000);
    const aliceContext = await browser.newContext({ reducedMotion: "reduce" });
    const bobContext = await browser.newContext({ reducedMotion: "reduce" });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await createRoomViaUi(alice, {
      displayName: "玩家甲",
      startingStack: 20,
      maxPlayers: 2,
      smallBlind: 1,
      bigBlind: 2,
    });
    const inviteCode = await readInviteCode(alice);
    await joinViaUi(bob, inviteCode, "玩家乙");
    await takeSeatAndReady(alice);
    await takeSeatAndReady(bob);

    await startTournamentViaUi(alice);
    await enterTableWhenReady(bob);
    // 双页并发驱动（与主流程一致）：单页驱动时轮到对方行动会让本页 10s 内
    // 无可观察状态变化，waitForTurnOrFinish 以超时拒绝。
    await driveTournamentToFinish([alice, bob]);
    await expect(bob.getByText("比赛已结束")).toBeVisible({ timeout: 60_000 });

    // 业务结果不因跳过动画而改变：结果页两行排名、筹码守恒 2 × 20 = 40
    //（<table> 仅结果页渲染，牌桌页是 RankingSummary 列表）。
    await alice.getByRole("link", { name: "查看比赛结果" }).click();
    await expect(alice.getByRole("heading", { name: "比赛结果" })).toBeVisible();
    const rows = alice.getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    const count = await rows.count();
    let sum = 0;
    for (let index = 0; index < count; index += 1) {
      const text = await rows.nth(index).locator("td").last().textContent();
      sum += Number((text ?? "0").replace(/,/g, ""));
    }
    expect(sum).toBe(40);

    await aliceContext.close();
    await bobContext.close();
  });
});
