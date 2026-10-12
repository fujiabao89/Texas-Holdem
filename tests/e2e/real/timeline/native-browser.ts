import { chromium, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  let browser: Browser | null = null;
  const close = async () => {
    await browser?.close().catch(() => undefined);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
        child.kill("SIGTERM");
      });
    // Verify the absolute owned profile before recursive cleanup on Windows too.
    if (dirname(realpathSync(profile)) !== realRoot || !basename(profile).startsWith("browser-"))
      throw new Error("invalid owned native browser profile");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
