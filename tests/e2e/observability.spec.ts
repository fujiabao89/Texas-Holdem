import { expect, test } from "./fixtures/observability";

/**
 * 可观测性门禁自测（docs/06 §9）：
 * 证明未处理的 console error / page error / HTTP 5xx 会使测试失败，
 * 以及 diagnostics.allow 白名单可豁免预期内错误。
 * 前三个用例用 test.fail 标记"预期失败"：门禁在 fixture teardown 抛出 →
 * 实际失败与预期一致即通过；若门禁失效（用例通过），test.fail 会将其报为失败。
 * 断言使用哨兵值过滤（而非计数），避免 dev server 噪音干扰。
 */

const CONSOLE_ERROR_SENTINEL = "TEX-TEST-GATE intentional console error";
const PAGE_ERROR_SENTINEL = "TEX-TEST-GATE intentional page error";
const ALLOW_SENTINEL = "TEX-TEST-GATE-ALLOW";

test.describe("docs/06 §9 门禁自测", () => {
  // test.fail 修饰符在 describe 作用域内持续生效：每个预期失败用例
  // 放入独立嵌套 describe，避免泄漏到后续用例。
  test.describe(() => {
    test.fail(true, "未处理 console error 必须使测试失败");
    test("console error 触发门禁", async ({ page, diagnostics }) => {
      await page.goto("/");
      await page.evaluate((message) => console.error(message), CONSOLE_ERROR_SENTINEL);
      await expect
        .poll(() =>
          diagnostics.consoleErrors.some((entry) => entry.includes(CONSOLE_ERROR_SENTINEL)),
        )
        .toBe(true);
    });
  });

  test.describe(() => {
    test.fail(true, "未处理 page error 必须使测试失败");
    test("page error 触发门禁", async ({ page, diagnostics }) => {
      await page.goto("/");
      await page.evaluate((message) => {
        setTimeout(() => {
          throw new Error(message);
        }, 0);
      }, PAGE_ERROR_SENTINEL);
      await expect
        .poll(() => diagnostics.pageErrors.some((entry) => entry.includes(PAGE_ERROR_SENTINEL)))
        .toBe(true);
    });
  });

  test.describe(() => {
    test.fail(true, "未处理 HTTP 5xx 必须使测试失败");
    test("HTTP 5xx 触发门禁", async ({ page, diagnostics }) => {
      await page.goto("/");
      await page.route("**/tex-test-gate-500", (route) =>
        route.fulfill({ status: 500, body: "intentional 500" }),
      );
      await page.evaluate(async () => {
        await fetch("/tex-test-gate-500").catch(() => undefined);
      });
      await expect
        .poll(() =>
          diagnostics.requests.some(
            (request) => request.status >= 500 && request.path.includes("tex-test-gate-500"),
          ),
        )
        .toBe(true);
    });
  });

  test("白名单豁免：diagnostics.allow 匹配的 console error 不触发门禁", async ({
    page,
    diagnostics,
  }) => {
    diagnostics.allow(ALLOW_SENTINEL);
    await page.goto("/");
    await page.evaluate((message) => console.error(message), `${ALLOW_SENTINEL} intentional`);
    await expect
      .poll(() => diagnostics.consoleErrors.some((entry) => entry.includes(ALLOW_SENTINEL)))
      .toBe(true);
  });

  test("白名单豁免：全局正则的 lastIndex 状态不使重复错误触发门禁", async ({
    page,
    diagnostics,
  }) => {
    // 带 g 标志的正则 test() 会保留 lastIndex：两条相同错误若交替
    // 匹配/不匹配，第二条会在 teardown 被门禁误判（回归守护）。
    diagnostics.allow(/TEX-TEST-GATE-ALLOW-GLOBAL/g);
    await page.goto("/");
    await page.evaluate(() => {
      console.error("TEX-TEST-GATE-ALLOW-GLOBAL intentional error 1");
      console.error("TEX-TEST-GATE-ALLOW-GLOBAL intentional error 2");
    });
    await expect
      .poll(
        () =>
          diagnostics.consoleErrors.filter((entry) => entry.includes("TEX-TEST-GATE-ALLOW-GLOBAL"))
            .length,
      )
      .toBe(2);
  });
});
