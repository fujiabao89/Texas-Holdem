/**
 * TEX-28 真实链路 E2E 的 UI 驱动 helper。
 *
 * 只通过真实浏览器 UI（可见角色/名称选择器）驱动业务流程；等待一律挂接在
 * 可观察状态上（docs/06 §5：禁止 route.fulfill 与任意 sleep/waitForTimeout）。
 * 文案与 apps/web/src/messages/zh-CN.ts 保持一致。
 */
import { expect, type Locator, type Page } from "@playwright/test";

export interface CreateRoomOptions {
  readonly displayName: string;
  readonly startingStack?: number;
  readonly maxPlayers?: number;
  readonly smallBlind?: number;
  readonly bigBlind?: number;
}

export async function createRoomViaUi(page: Page, options: CreateRoomOptions): Promise<void> {
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "创建私人房间" })).toBeVisible();
  await page.getByLabel("昵称").fill(options.displayName);
  if (options.maxPlayers !== undefined)
    await page.getByLabel("最大人数").fill(String(options.maxPlayers));
  if (options.startingStack !== undefined)
    await page.getByLabel("初始筹码").fill(String(options.startingStack));
  // 表单默认盲注 50/100（room-presets.ts）；小筹码场景必须显式降低盲注，
  // 否则筹码 < 大盲注会导致每手自动全下、锦标赛秒级自动完成（房间直接 FINISHED）。
  if (options.smallBlind !== undefined)
    await page.getByLabel("小盲注").fill(String(options.smallBlind));
  if (options.bigBlind !== undefined)
    await page.getByLabel("大盲注").fill(String(options.bigBlind));
  await page.getByRole("button", { name: "创建并进入大厅" }).click();
  await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible({ timeout: 30_000 });
}

export async function readInviteCode(page: Page): Promise<string> {
  const section = page.locator('section[aria-labelledby="invite-heading"]');
  await expect(section).toBeVisible();
  const code = await section.locator("p").first().textContent();
  if (code === null || !/^[A-Z2-9]{6}$/.test(code)) throw new Error(`邀请码读取失败：${code}`);
  return code;
}

export async function joinViaUi(
  page: Page,
  inviteCode: string,
  displayName: string,
): Promise<void> {
  await page.goto(`/join?code=${inviteCode}`);
  await expect(page.getByRole("heading", { name: "加入私人房间" })).toBeVisible();
  await page.getByLabel("昵称").fill(displayName);
  await page.getByRole("button", { name: "加入房间" }).click();
  await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible({ timeout: 30_000 });
}

/** 入座第一个空位并点击准备。 */
export async function takeSeatAndReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible();
  await page.getByRole("button", { name: "选择此座位" }).first().click();
  // 入座后「准备」按钮才渲染；点击后切换为「取消准备」（lobby-page.tsx）。
  const ready = page.getByRole("button", { name: "准备", exact: true });
  await expect(ready).toBeEnabled({ timeout: 15_000 });
  await ready.click();
  await expect(page.getByRole("button", { name: "取消准备" })).toBeEnabled({ timeout: 15_000 });
}

/** 房主开局并进入牌桌。 */
export async function startTournamentViaUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: "开始比赛" }).click();
  const enterTable = page.getByRole("link", { name: "进入牌桌" });
  await expect(enterTable).toBeVisible({ timeout: 30_000 });
  await enterTable.click();
  await expect(page.getByRole("heading", { name: "牌桌", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** 非开局者等待牌桌入口出现后进入。 */
export async function enterTableWhenReady(page: Page): Promise<void> {
  const enterTable = page.getByRole("link", { name: "进入牌桌" });
  await expect(enterTable).toBeVisible({ timeout: 30_000 });
  await enterTable.click();
  await expect(page.getByRole("heading", { name: "牌桌", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** 动作优先级：全下确认 > 全下 > 跟注 > 过牌 > 弃牌（最快结束锦标赛）。 */
const ACTION_PATTERNS: readonly RegExp[] = [
  /^再次点击确认全下至 \d+$/,
  /^全下至 \d+$/,
  /^跟注 \d+$/,
  /^过牌$/,
  /^弃牌$/,
];

async function firstVisibleAction(page: Page): Promise<Locator | null> {
  for (const name of ACTION_PATTERNS) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible()) return button;
  }
  return null;
}

/** 等待「出现可操作按钮」或「比赛结束」——只挂接可观察状态。 */
function waitForTurnOrFinish(page: Page): Promise<void> {
  const finished = page.getByText("比赛已结束").first();
  return Promise.race([
    // 两个分支的 waitFor 都吞掉 rejection：10s 内既无按钮也无结束文案时回到外层
    // 90s deadline 循环判定（WebKit 慢机器上等别人行动可能超过单轮 10s，不能提前抛）。
    finished.waitFor({ timeout: 10_000 }).then(
      () => undefined,
      () => undefined,
    ),
    ...ACTION_PATTERNS.map((name) =>
      page
        .getByRole("button", { name })
        .first()
        .waitFor({ timeout: 10_000 })
        .then(
          () => undefined,
          () => undefined,
        ),
    ),
  ]);
}

/**
 * 单页驱动到比赛结束：轮到本玩家时按优先级出牌（全下优先，最快见分晓）。
 * 动作按钮仅在轮到本人且存在合法动作时渲染，循环只推进可观察状态。
 */
export async function playUntilTournamentFinished(page: Page): Promise<void> {
  const finished = page.getByText("比赛已结束").first();
  const deadline = Date.now() + 90_000;
  while (!(await finished.isVisible().catch(() => false))) {
    if (Date.now() > deadline) throw new Error("等待比赛结束超时（90s）");
    const action = await firstVisibleAction(page);
    if (action === null) {
      await waitForTurnOrFinish(page);
      continue;
    }
    const label = await action.textContent();
    await action.click();
    if (label !== null && label.startsWith("全下至")) {
      // 全下需要二次确认（防误触；docs/05 §9）。
      const confirm = page.getByRole("button", { name: /^再次点击确认全下至 \d+$/ }).first();
      await confirm.waitFor({ state: "visible", timeout: 10_000 });
      await confirm.click();
      await confirm.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    } else {
      // 命令生效后按钮组随 legalActions 清空而消失；等待其隐藏防重复提交。
      await action.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    }
  }
  await expect(finished).toBeVisible();
}

/** 多页并发驱动到全部结束。 */
export async function driveTournamentToFinish(pages: readonly Page[]): Promise<void> {
  await Promise.all(pages.map((page) => playUntilTournamentFinished(page)));
}
