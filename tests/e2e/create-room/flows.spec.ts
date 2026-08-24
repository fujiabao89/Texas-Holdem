import { criticalViolations } from "../fixtures/a11y";
import { expect, test } from "../fixtures/observability";

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
