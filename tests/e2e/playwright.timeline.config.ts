import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import real from "./playwright.real.config";

// Playwright's automatic accessibility snapshot contains private hole cards.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

const tier = process.env.TEX_TIMELINE_TIER ?? "pr";
if (tier !== "pr" && tier !== "rc") throw new Error("TEX_TIMELINE_TIER must be pr or rc");
const scenario = process.env.TEX_TIMELINE_SCENARIO ?? "timeline";
if (!["timeline", "split", "background"].includes(scenario))
  throw new Error("invalid TEX_TIMELINE_SCENARIO");
const servers = Array.isArray(real.webServer) ? real.webServer : [];
export default defineConfig({
  ...real,
  testDir: "./real/timeline",
  testMatch: `${scenario}.spec.ts`,
  testIgnore: [],
  outputDir: `.artifacts-timeline/${scenario}`,
  retries: 0,
  // CI defaults also capture source diffs, which can contain environment URLs.
  // Immutable HEAD/dirty provenance is already recorded by our evidence gate.
  captureGitInfo: { commit: false, diff: false },
  workers: 1,
  globalTeardown: "./real/timeline/global-teardown",
  timeout: 240_000,
  grep: tier === "pr" ? /@timeline-pr/ : /@timeline-(pr|rc)/,
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(__dirname, `.artifacts-timeline/${scenario}/results.json`) }],
  ],
  use: {
    ...real.use,
    headless: process.env.TEX_TIMELINE_HEADED !== "1",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@timeline-pr.*@key/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@timeline-pr.*@key/ },
  ],
  webServer: servers.map((server, index) => ({
    ...server,
    // Production assets remove HMR/cold route compilation from 15-second game timing.
    ...(index === 1
      ? {
          command: `pnpm --filter @texas-holdem/web build --webpack && pnpm --filter @texas-holdem/web start --port ${Number(process.env.TEX_E2E_REAL_WEB_PORT ?? 3202)}`,
          timeout: 180_000,
        }
      : {}),
    env: {
      ...server.env,
      ...(index === 0
        ? { TEX_TIMELINE_LOG: resolve(__dirname, ".artifacts-timeline/server.jsonl") }
        : {}),
    },
  })),
});
