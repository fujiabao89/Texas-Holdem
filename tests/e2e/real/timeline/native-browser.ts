import { chromium, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** An owned empty profile, with native visibility and no Playwright focus overrides. */
export async function openNativeBackgroundBrowser() {
  const root = resolve(tmpdir(), "tex62-native");
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  const profile = mkdtempSync(join(realRoot, "browser-"));
  const child = spawn(
    chromium.executablePath(),
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let processClosed = false;
  const closed = new Promise<void>((done) =>
    child.once("close", () => {
      processClosed = true;
      done();
    }),
  );
  let browser: Browser | null = null;
  const close = async () => {
    // connectOverCDP's browser.close disconnects the client. Ask our owned
    // native browser to exit gracefully before waiting for its process pipes.
    if (browser !== null) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page !== undefined) {
        const session = await page
          .context()
          .newCDPSession(page)
          .catch(() => null);
        await session?.send("Browser.close").catch(() => undefined);
      }
    }
    await browser?.close().catch(() => undefined);
    if (child.pid !== undefined && !processClosed) {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await Promise.race([
          closed,
          new Promise<void>((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error("owned native browser close timeout")),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(killTimer);
        clearTimeout(closeTimer);
      }
    }
    // Verify the absolute owned profile before recursive cleanup on Windows too.
    if (dirname(realpathSync(profile)) !== realRoot || !basename(profile).startsWith("browser-"))
      throw new Error("invalid owned native browser profile");
    // Async retries let Chromium's remaining file handles finish closing;
    // sync recursive removal can race its final profile writes (ENOTEMPTY).
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  try {
    const endpoint = await new Promise<string>((done, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("native browser startup timeout")), 15_000);
      const fail = () => {
        clearTimeout(timeout);
        reject(new Error("native browser startup failed"));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.stderr.on("data", (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-16_384);
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match !== null) {
          clearTimeout(timeout);
          child.off("error", fail);
          child.off("exit", fail);
          done(match[1]!);
        }
      });
    });
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true });
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
