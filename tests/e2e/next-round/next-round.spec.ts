import { expect, test } from "../fixtures/observability";
import { scanAxeViolations } from "../fixtures/a11y";
import { joinViaUi, takeSeatAndReady } from "../real/support/ui";
import { nextRoundFixture } from "./lobby-fixture";

const resultUrl = "/room/room-49/result/old-49";
const reopenName = "返回大厅，筹备下一局";

test("开局仅推送房间场号时，立即认证恢复初始快照而不等待行动开放", async ({ page }) => {
  const fixture = nextRoundFixture();
  fixture.change({ status: "LOBBY", inviteCode: "ABC234" });
  fixture.onlyRoomOnStart();
  await fixture.install(page);
  await page.goto("/room/room-49");
  await page.getByRole("button", { name: "开始比赛" }).click();
  await expect(page).toHaveURL(/\/room\/room-49\/table$/);
  await expect(page.locator("[data-seat]")).toHaveCount(2);
  // Initial Lobby authentication, one new-tournament recovery, then the table mount.
  await expect.poll(() => fixture.authentications.length).toBe(3);
  await expect(page.getByRole("button", { name: "弃牌", exact: true })).toHaveCount(0);
  expect(fixture.snapshot().activeTournamentId).toBe("new-49");
});

test("房主重开、外部加入、全员准备进入新比赛，旧赛果与历史可独立刷新", async ({ page, browser }, info) => {
  const fixture = nextRoundFixture();
  const memberContext = await browser.newContext();
  const newcomerContext = await browser.newContext();
  const member = await memberContext.newPage();
  const newcomer = await newcomerContext.newPage();
  await fixture.install(page);
  await fixture.install(member, "player-2");
  await fixture.install(newcomer, "player-3", false);
  await page.goto(resultUrl);
  await member.goto(resultUrl);
  await expect(member.getByRole("button", { name: reopenName })).toHaveCount(0);
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: reopenName }).click();
  await expect(page).toHaveURL(/\/room\/room-49$/);
  expect(fixture.requests.map(r => r.body.operation)).toEqual([{ type: "REOPEN_LOBBY" }]);
  expect(fixture.requests.every(r => r.method !== "POST")).toBe(true);
  await expect(page.locator(".lobby-seat-feedback").getByText(/未准备/)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "开始比赛" })).toBeDisabled();
  await expect(member.getByText("房主已开放筹备大厅，请返回大厅入座并重新准备。")).toBeVisible();
  await member.getByRole("link", { name: "返回大厅", exact: true }).last().click();
  await joinViaUi(newcomer, "ABC234", "新玩家");
  await expect(page.getByRole("region", { name: "等待入座的成员" })).toContainText("新玩家");
  await expect(page.getByText("新玩家 尚未入座。")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始比赛" })).toBeDisabled();
  await expect(newcomer.getByRole("button", { name: "准备", exact: true })).toBeDisabled();
  await takeSeatAndReady(newcomer);
  for (const p of [page, member]) {
    await p.getByRole("button", { name: "准备", exact: true }).click();
    await expect(p.getByRole("button", { name: "取消准备" })).toBeEnabled();
  }
  expect(await scanAxeViolations(page, { minImpact: "serious" })).toEqual([]);
  await page.screenshot({ path: info.outputPath("ready-lobby.png"), fullPage: true });
  await page.getByRole("button", { name: "开始比赛" }).click();
  for (const p of [page, member, newcomer]) {
    await expect(p).toHaveURL(/\/room\/room-49\/table$/);
    await expect(p.locator("[data-seat]")).toHaveCount(3);
    await expect(p.getByText("1,000", { exact: true })).toHaveCount(3);
  }
  expect(fixture.snapshot().activeTournamentId).toBe("new-49");
  await member.goto(resultUrl);
  await member.reload();
  await expect(member.getByRole("table").locator("tbody tr")).toHaveCount(2);
  await expect(member.getByRole("table")).toContainText("2,000");
  await expect(member.getByRole("button", { name: reopenName })).toHaveCount(0);
  fixture.newHandEvent();
  await member.getByRole("button", { name: "牌局记录", exact: true }).click();
  await expect(member.getByRole("dialog")).toContainText("还没有已归档的手牌。");
  await expect(member.getByText("本手进行中", { exact: true })).toHaveCount(0);
  await memberContext.close();
  await newcomerContext.close();
});

test("房主转移和关闭由最新快照控制，非房主没有重开按钮", async ({ page }) => {
  const fixture = nextRoundFixture();
  await fixture.install(page, "player-2");
  await page.goto(resultUrl);
  await expect(page.getByText("等待房主重新开放筹备大厅。")).toBeVisible();
  fixture.change({ hostPlayerId: "player-2" });
  await expect(page.getByRole("button", { name: reopenName })).toBeEnabled();
  fixture.change({ hostPlayerId: "player-1" });
  await expect(page.getByRole("button", { name: reopenName })).toHaveCount(0);
  fixture.change({ status: "CLOSED", inviteCode: null });
  await expect(page.getByText("房间已关闭，邀请码已永久失效。")).toBeVisible();
  await expect(page.getByRole("button", { name: "复制邀请码" })).toHaveCount(0);
});

test("过期 revision、重开失败与重复点击不伪造大厅；刷新后可重试", async ({ page, diagnostics }) => {
  diagnostics.allow(/Failed to load resource: the server responded with a status of 409/);
  const fixture = nextRoundFixture();
  await fixture.install(page);
  await page.goto(resultUrl);
  fixture.holdNext();
  fixture.failNext("STALE_ROOM_STATE");
  await page.getByRole("button", { name: reopenName }).click();
  await expect(page.getByRole("button", { name: "正在提交，请稍候。" })).toBeDisabled();
  expect(fixture.requests).toHaveLength(1);
  fixture.release();
  await expect(page.getByText("房间信息已更新，请重新确认操作。")).toBeVisible();
  await expect(page).toHaveURL(/\/result\/old-49$/);
  expect(fixture.snapshot().status).toBe("FINISHED");
  await page.reload();
  await page.getByRole("button", { name: reopenName }).click();
  await expect(page).toHaveURL(/\/room\/room-49$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始比赛" })).toBeDisabled();
  await expect(page.locator(".rr-invite-code")).toHaveText("ABC234");
});

test("离线及未入座成员明确阻塞开局，房主可踢出；加入先提交时开局失败", async ({ page, diagnostics }) => {
  diagnostics.allow(/Failed to load resource: the server responded with a status of 409/);
  const fixture = nextRoundFixture();
  fixture.change({ status: "LOBBY", inviteCode: "ABC234", players: [...fixture.snapshot().players, { playerId: "offline", displayName: "离线成员", seat: null, ready: true, connectionStatus: "DISCONNECTED", pokerStatus: "ACTIVE" }] });
  await fixture.install(page);
  await page.goto("/room/room-49");
  await expect(page.getByText("离线成员 已离线，请等待重连或由房主移出房间。")).toBeVisible();
  await expect(page.getByText("离线成员 尚未入座。")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始比赛" })).toBeDisabled();
  await page.getByRole("button", { name: "移出房间：离线成员" }).click();
  const start = page.getByRole("button", { name: "开始比赛" });
  await expect(start).toBeEnabled();
  fixture.holdNext();
  await start.click();
  await expect(start).toBeDisabled();
  fixture.change({ players: [...fixture.snapshot().players, { playerId: "new", displayName: "并发加入", seat: null, ready: false, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" }] });
  fixture.release();
  await expect(page.getByText("房间信息已更新，请重新确认操作。")).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(page.getByText("并发加入 尚未准备。")).toBeVisible();
  expect(fixture.snapshot().status).toBe("LOBBY");
  fixture.change({ hostPlayerId: "player-2" });
  await expect(start).toHaveCount(0);
});

for (const status of ["IN_GAME", "FINISHED", "CLOSED"] as const) {
  test(`${status} 隐藏邀请码并说明暂停或永久失效`, async ({ page }) => {
    const fixture = nextRoundFixture();
    fixture.change({ status, inviteCode: null });
    await fixture.install(page);
    await page.goto("/room/room-49");
    await expect(page.getByText(status === "CLOSED" ? "房间已关闭，邀请码已永久失效。" : "比赛进行中或已结束，邀请码暂时停用，当前不可加入。")).toBeVisible();
    await expect(page.getByRole("button", { name: "复制邀请码" })).toHaveCount(0);
    await expect(page.locator(".rr-invite-code")).toHaveCount(0);
  });
}
