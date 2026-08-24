import { criticalViolations } from "../fixtures/a11y";
import { expect, test } from "../fixtures/observability";

const lobbySnapshot = {
  snapshotVersion: 1, roomId: "room-1", roomRevision: "1", status: "LOBBY", inviteCode: "ABC234", hostPlayerId: "player-1",
  config: { maxPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed", blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: 30, timeBank: 60 },
  activeTournamentId: null,
  players: [{ playerId: "player-1", displayName: "玩家甲", seat: null, ready: false, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" }],
};

test("Home 只提供创建和加入入口", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.getByRole("link")).toHaveCount(2);
  expect(await criticalViolations(page)).toEqual([]);
});

test("邀请链接只预填邀请码，仍要求昵称", async ({ page }) => {
  await page.goto("/join?code=ABC234");
  const fields = page.getByRole("textbox");
  await expect(fields.nth(0)).toHaveValue("ABC234");
  await expect(fields.nth(1)).toHaveValue("");
  await expect(fields.nth(1)).toHaveAttribute("required", "");
  expect(await criticalViolations(page)).toEqual([]);
});

test("创建成功后以 HTTP 的权威 RoomSnapshot 进入 Lobby", async ({ page }) => {
  await page.route("**/api/v1/rooms", async (route) => {
    await route.fulfill({ json: { data: { roomId: "room-1", playerId: "player-1", playerToken: "x".repeat(43), roomSnapshot: lobbySnapshot } } });
  });
  await page.goto("/create");
  await expect(page.getByRole("button", { name: "创建并进入大厅" })).toBeEnabled();
  await page.getByRole("textbox").fill("玩家甲");
  await page.getByRole("button", { name: "创建并进入大厅" }).click();
  await expect(page).toHaveURL(/\/room\/room-1$/);
  await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible();
});
