import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  applyPlayerViewPatch,
  ServerMessageSchema,
  type GameSnapshot,
  type GameEventMessage,
} from "../../../../packages/protocol/src";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { performance as nodePerformance } from "node:perf_hooks";
import {
  createNetworkProxy,
  type NetworkProxy,
  type NetworkProfile,
} from "../../../support/network-proxy";
import {
  authoritativeViolations,
  timelineViolations,
  isSafeEvidence,
  type DomSample,
  type SafeDiagnostic,
} from "../../../support/timeline-evidence";
import { readRunIdentity } from "../support/run-identity";
import {
  createRoomViaUi,
  readInviteCode,
  joinViaUi,
  takeSeatAndReady,
  enterTableWhenReady,
  startTournamentViaUi,
} from "../support/ui";

interface FrameSummary {
  at: number;
  type: string;
  serverTime: number;
  handId: string | null;
  sequence: string | null;
  event?: string;
  phase?: string | null;
  deadline?: number | null;
  actor?: string | null;
  hasLegalActions?: boolean;
  reason?: string;
}
export interface PlayerProbe {
  page: Page;
  context: BrowserContext;
  proxy: NetworkProxy;
  game: GameSnapshot | null;
  frames: FrameSummary[];
  events: GameEventMessage[];
  errors: string[];
  suspendActions?: boolean;
  backgroundHands?: Set<string>;
}
export interface TimelineSession {
  players: PlayerProbe[];
  create(
    count: number,
    options?: {
      reduced?: boolean;
      stack?: number;
      blind?: number;
      profile?: NetworkProfile;
      viewport?: { width: number; height: number };
    },
  ): Promise<void>;
  drive(handCount: number, policy?: "passive" | "fold" | "all-in"): Promise<void>;
  action(policy?: "passive" | "fold" | "all-in"): Promise<void>;
  logs(): SafeDiagnostic[];
  assert(): Promise<void>;
}

async function installObservation(context: BrowserContext, proxyPort: number, serverPort: number) {
  await context.addInitScript(
    ({ proxyPort, serverPort }) => {
      // Native socket, native callbacks and bytes. Only its destination changes to the TCP proxy.
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      const timeSamples: {
        sent: number;
        received: number;
        serverReceived: number;
        serverSent: number;
      }[] = [];
      Object.assign(window, { __texSockets: sockets, __texTimeSamples: timeSamples });
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const endpoint = new URL(String(url));
          const gameSocket =
            endpoint.port === String(serverPort) && endpoint.pathname === "/api/v1/ws";
          if (gameSocket) endpoint.port = String(proxyPort);
          super(endpoint, protocols);
          if (gameSocket) {
            sockets.push(this);
            this.addEventListener("message", (event) => {
              try {
                const message = JSON.parse(String(event.data));
                if (message.type !== "TIME_SYNC_RESULT" || timeSamples.length >= 512) return;
                const {
                  clientSentAt: sent,
                  serverReceivedAt: serverReceived,
                  serverSentAt: serverSent,
                } = message.payload;
                if ([sent, serverReceived, serverSent].every(Number.isFinite))
                  timeSamples.push({
                    sent,
                    received: performance.now(),
                    serverReceived,
                    serverSent,
                  });
              } catch {
                /* the strict passive wire observer reports invalid messages */
              }
            });
          }
        }
      };
      const samples: DomSample[] = [];
      const frameIntervals: number[] = [];
      const evidence = { samples, frameIntervals, overflow: false };
      Object.assign(window, { __texTimeline: evidence });
      let previous = "";
      const record = (kind = "mutation", animation?: string, dealKey?: string) => {
        const table = document.querySelector("[data-hand-id]");
        const sample: DomSample = {
          at: performance.now(),
          handId: table?.getAttribute("data-hand-id") ?? null,
          actionHandId:
            document.querySelector("[data-action-hand-id]")?.getAttribute("data-action-hand-id") ??
            null,
          outcomeHandId:
            document
              .querySelector("[data-outcome-hand-id]")
              ?.getAttribute("data-outcome-hand-id") ?? null,
          mode: table?.getAttribute("data-presentation-mode") ?? null,
          phase: table?.querySelector(".table-phase")?.textContent ?? null,
          reduced:
            document
              .querySelector("main[data-reduced-motion]")
              ?.getAttribute("data-reduced-motion") === "true",
          visibility: document.visibilityState,
          kind,
          ...(animation === undefined ? {} : { animation }),
          showdown: document.querySelector(".showdown-showcase") !== null,
          awardLines: Array.from(
            document.querySelectorAll("[data-outcome-hand-id] li"),
            (item) => item.textContent?.trim() ?? "",
          ),
          synchronized:
            document.body?.textContent?.includes("牌局进度已同步至最新状态") ||
            document.body?.textContent?.includes("已重新连接并同步到最新牌局") ||
            false,
          ...(dealKey === undefined ? {} : { dealKey }),
        };
        const key = JSON.stringify({ ...sample, at: 0 });
        if (key === previous && kind === "mutation") return;
        previous = key;
        if (samples.length < 20_000) samples.push(sample);
        else evidence.overflow = true;
      };
      document.addEventListener("visibilitychange", () => record("visibility"));
      document.addEventListener(
        "animationstart",
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.matches(".hole-deal-flight, .showdown-showcase")
          )
            record(
              "animationstart",
              event.animationName,
              event.target.getAttribute("data-deal-event-key") ?? undefined,
            );
        },
        true,
      );
      document.addEventListener("DOMContentLoaded", () => {
        // Keep card geometry/animations and accessible DOM intact, cover values in persisted video.
        const style = document.createElement("style");
        style.textContent =
          "[data-card-rank]::after { content:''; position:absolute; inset:0; background:#355e40; z-index:100; border-radius:inherit; }";
        document.head.append(style);
        new MutationObserver(() => record()).observe(document.documentElement, {
          subtree: true,
          attributes: true,
          childList: true,
        });
        record();
        let last: number | undefined;
        const frame = (now: number) => {
          if (
            document.visibilityState === "visible" &&
            last !== undefined &&
            frameIntervals.length < 3000
          )
            frameIntervals.push(now - last);
          last = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },
    { proxyPort, serverPort },
  );
}

async function domEvidence(
  page: Page,
): Promise<{ samples: DomSample[]; frameIntervals: number[]; overflow: boolean }> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __texTimeline: { samples: DomSample[]; frameIntervals: number[]; overflow: boolean };
        }
      ).__texTimeline,
  );
}

function observe(page: Page, context: BrowserContext, proxy: NetworkProxy): PlayerProbe {
  const probe: PlayerProbe = {
    page,
    context,
    proxy,
    game: null,
    frames: [],
    events: [],
    errors: [],
  };
  const recordError = (error: string) => {
    if (!probe.errors.includes(error) && probe.errors.length < 100) probe.errors.push(error);
  };
  page.on("pageerror", () => recordError("pageerror"));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/WebSocket.*(closed before|connection|interrupted)|can['’]t establish a connection|was interrupted while the page was loading|Failed to load resource: net::ERR_(CONNECTION|INTERNET)/i.test(
        message.text(),
      )
    )
      recordError("console error");
  });
  page.on("response", (response) => {
    if (response.status() >= 500) recordError(`HTTP ${response.status()}`);
  });
  page.on("websocket", (socket) => {
    const endpoint = new URL(socket.url());
    if (endpoint.port !== String(proxy.port) || endpoint.pathname !== "/api/v1/ws") return;
    socket.on("framereceived", (frame) => {
      let stage = "decode";
      try {
        const decoded = JSON.parse(String(frame.payload)) as {
          type?: string;
          payload?: { event?: { type?: string } };
        };
        const kind = [decoded.type, decoded.payload?.event?.type]
          .filter((value) => typeof value === "string" && /^[A-Z_]{1,40}$/.test(value))
          .join("/");
        stage = `message validation ${kind}`;
        const message = ServerMessageSchema.parse(decoded);
        const payload = message.payload;
        const summary: FrameSummary = {
          at: nodePerformance.now(),
          type: message.type,
          serverTime: message.serverTime,
          handId: "handId" in payload ? payload.handId : null,
          sequence: "sequence" in payload ? payload.sequence : null,
        };
        if (message.type === "GAME_SNAPSHOT") {
          probe.game = message.payload;
          Object.assign(summary, {
            phase: probe.game.handPhase,
            actor: probe.game.currentActorPlayerId,
            deadline: probe.game.actionDeadline,
            reason: probe.game.reason,
            hasLegalActions: probe.game.viewer.legalActions !== null,
          });
        } else if (message.type === "RECONNECT_RESULT" && message.payload.gameSnapshot !== null) {
          probe.game = message.payload.gameSnapshot;
          Object.assign(summary, {
            handId: probe.game.handId,
            sequence: probe.game.sequence,
            phase: probe.game.handPhase,
            deadline: probe.game.actionDeadline,
            actor: probe.game.currentActorPlayerId,
            reason: "RECONNECT",
            hasLegalActions: probe.game.viewer.legalActions !== null,
          });
        } else if (message.type === "GAME_EVENT") {
          if (probe.suspendActions && message.payload.handId !== null)
            probe.backgroundHands?.add(message.payload.handId);
          probe.events.push(message);
          summary.event = message.payload.event.type;
          const game = probe.game;
          if (
            game !== null &&
            game.tournamentId === message.payload.tournamentId &&
            BigInt(message.payload.sequence) === BigInt(game.sequence) + 1n
          ) {
            stage = `patch ${message.payload.event.type}`;
            const {
              snapshotVersion: _sv,
              reason: _reason,
              tournamentId: _tid,
              sequence: _seq,
              ...view
            } = game;
            probe.game = {
              ...game,
              ...applyPlayerViewPatch(view, message.payload.patch),
              handId: message.payload.handId,
              sequence: message.payload.sequence,
            };
            Object.assign(summary, {
              phase: probe.game.handPhase,
              actor: probe.game.currentActorPlayerId,
              deadline: probe.game.actionDeadline,
              hasLegalActions: probe.game.viewer.legalActions !== null,
            });
          }
        }
        if (probe.frames.length >= 20_000) throw new Error("frame limit");
        probe.frames.push(summary);
      } catch (error) {
        const codes =
          error !== null && typeof error === "object" && "issues" in error
            ? (error as { issues: { code: string; path: unknown[] }[] }).issues
                .map((issue) => `${issue.code}:${issue.path.join(".")}`)
                .join(",")
                .slice(0, 200)
            : "error";
        recordError(`${stage}: ${codes}`);
      }
    });
  });
  return probe;
}

export const test = base.extend<{ timeline: TimelineSession }>({
  timeline: async ({ browser, baseURL }, provide, info) => {
    const identity = readRunIdentity();
    const players: PlayerProbe[] = [];
    let stopDriving: (() => boolean) | null = null;
    let roomId: string | null = null;
    const videoFiles: string[] = [];
    const session: TimelineSession = {
      players,
      async create(count, options = {}) {
        for (let index = 0; index < count; index++) {
          const proxy = await createNetworkProxy(identity.serverPort);
          const videoDir = info.outputPath(`player-${index}-video`);
          mkdirSync(videoDir, { recursive: true });
          const context = await browser.newContext({
            baseURL,
            reducedMotion: options.reduced ? "reduce" : "no-preference",
            viewport: options.viewport,
            recordVideo: { dir: videoDir },
          });
          await installObservation(context, proxy.port, identity.serverPort);
          const page = await context.newPage();
          players.push(observe(page, context, proxy));
        }
        const host = players[0]!.page;
        await createRoomViaUi(host, {
          displayName: "时序玩家0",
          maxPlayers: count,
          startingStack: options.stack ?? 1000,
          smallBlind: options.blind ?? 1,
          bigBlind: (options.blind ?? 1) * 2,
          actionTime: 15,
          timeBank: 0,
        });
        roomId = new URL(host.url()).pathname.split("/").at(-1)!;
        const invite = await readInviteCode(host);
        for (let index = 1; index < count; index++)
          await joinViaUi(players[index]!.page, invite, `时序玩家${index}`);
        for (const player of players) await takeSeatAndReady(player.page);
        if (options.profile !== undefined) players.at(-1)!.proxy.setProfile(options.profile);
        // Warm the route before the 15-second opportunity exists, with no live room/session.
        await fetch(`${baseURL}/room/00000000-0000-4000-8000-000000000062/table`);
        await startTournamentViaUi(host);
        await Promise.all(players.slice(1).map((player) => enterTableWhenReady(player.page)));
        await expect
          .poll(() => players.every((player) => player.game !== null), { timeout: 30_000 })
          .toBe(true);
      },
      async action(policy = "passive") {
        if (stopDriving?.()) return;
        for (const probe of players)
          expect(probe.errors, "observer and browser errors").toEqual([]);
        const buttonFor = (candidate: PlayerProbe) =>
          policy === "fold"
            ? candidate.page.getByRole("button", { name: "弃牌", exact: true })
            : policy === "all-in" && candidate.game?.viewer.legalActions?.canAllIn
              ? candidate.page.getByRole("button", { name: /^全下至 \d+$/ })
              : candidate.page.getByRole("button", { name: /^过牌$|^跟注 \d+$/ }).first();
        let player: PlayerProbe | undefined;
        await expect
          .poll(
            async () => {
              if (stopDriving?.()) return true;
              player = undefined;
              for (const candidate of players) {
                if (
                  candidate.suspendActions ||
                  candidate.game?.viewer.legalActions == null ||
                  candidate.game.currentActorPlayerId !== candidate.game.viewer.playerId
                )
                  continue;
                if (
                  (await buttonFor(candidate).isVisible()) &&
                  (await buttonFor(candidate).isEnabled())
                ) {
                  player = candidate;
                  return true;
                }
              }
              return false;
            },
            { timeout: 25_000 },
          )
          .toBe(true);
        if (stopDriving?.()) return;
        if (player === undefined) throw new Error("no visible legal actor");
        const actor = player;
        const sequence = actor.game!.sequence;
        const allInButton = policy === "all-in" && actor.game!.viewer.legalActions!.canAllIn;
        const button = buttonFor(actor);
        if (process.env.TEX_TIMELINE_SCENARIO === "background") await actor.page.bringToFront();
        await expect(button).toBeEnabled();
        await button.click();
        if (allInButton)
          await actor.page.getByRole("button", { name: /^再次点击确认全下至 \d+$/ }).click();
        await expect.poll(() => actor.game?.sequence, { timeout: 15_000 }).not.toBe(sequence);
      },
      async drive(handCount, policy = "passive") {
        // A terminal authority snapshot lets the driver continue even when the regression
        // drops settlement events. Branch assertions still require the actual events.
        const completedFor = (player: PlayerProbe) =>
          new Set(
            [
              ...player.events
                .filter((event) => event.payload.event.type === "POT_AWARDED")
                .map((event) => event.payload.handId),
              ...player.frames
                .filter((frame) => frame.phase === "SHOWDOWN_DISPLAY" || frame.phase === "HAND_END")
                .map((frame) => frame.handId),
            ].filter((handId) => handId !== null),
          ).size;
        const completed = () => completedFor(players[0]!);
        stopDriving = () => completed() >= handCount;
        try {
          while (completed() < handCount) {
            if (players[0]!.game?.tournamentStatus === "FINISHED") {
              await expect.poll(completed, { timeout: 5000 }).toBeGreaterThanOrEqual(handCount);
              break;
            }
            await session.action(policy);
          }
        } finally {
          stopDriving = null;
        }
        await expect
          .poll(() => players.every((player) => completedFor(player) >= handCount))
          .toBe(true);
      },
      logs() {
        try {
          return readFileSync(resolve(__dirname, "../../.artifacts-timeline/server.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as SafeDiagnostic)
            .filter((row) => row.roomId === roomId);
        } catch {
          return [];
        }
      },
      async assert() {
        const logs = session.logs();
        expect(logs.length, "production diagnostics must be captured").toBeGreaterThan(0);
        expect(
          logs.some((row) => row.event === "HAND_STARTED"),
          "scenario reached a real hand",
        ).toBe(true);
        expect(authoritativeViolations(logs)).toEqual([]);
        for (const player of players) {
          expect(player.errors).toEqual([]);
          expect(player.proxy.errors).toEqual([]);
          expect(
            player.frames
              .filter((frame) => frame.phase === "SHOWDOWN_DISPLAY")
              .every(
                (frame) =>
                  frame.actor === null && frame.deadline === null && frame.hasLegalActions !== true,
              ),
            "showdown has no action opportunity",
          ).toBe(true);
          const expectedAwards = player.events.flatMap((frame) => {
            if (
              frame.payload.event.type !== "POT_AWARDED" ||
              (frame.payload.handId !== null && player.backgroundHands?.has(frame.payload.handId))
            )
              return [];
            return frame.payload.event.payload.awards.map((award) => ({
              handId: frame.payload.handId,
              line: `${player.game?.players.find((candidate) => candidate.playerId === award.playerId)?.displayName} 获得 ${award.amount}`,
            }));
          });
          // The observer records transport acceptance before semantic playback
          // completes. Await actual DOM allocation, including a paced showdown,
          // rather than inspecting immediately after the final action's frame.
          await expect
            .poll(
              async () => {
                const dom = await domEvidence(player.page);
                return expectedAwards.every((award) =>
                  dom.samples.some(
                    (sample) =>
                      sample.outcomeHandId === award.handId &&
                      sample.awardLines?.includes(award.line),
                  ),
                );
              },
              { timeout: 45_000, message: "all received allocations became visible" },
            )
            .toBe(true);
          const dom = await domEvidence(player.page);
          expect(dom.overflow).toBe(false);
          expect(dom.samples.some((sample) => sample.handId !== null)).toBe(true);
          expect(timelineViolations(dom.samples)).toEqual([]);
          for (const frame of player.events) {
            if (frame.payload.event.type !== "POT_AWARDED") continue;
            // Recovery skips the old hand's unseen background presentation. The background
            // scenario separately proves native hidden/visible and a fresh authority barrier.
            if (frame.payload.handId !== null && player.backgroundHands?.has(frame.payload.handId))
              continue;
            for (const award of frame.payload.event.payload.awards) {
              const name = player.game?.players.find(
                (candidate) => candidate.playerId === award.playerId,
              )?.displayName;
              expect(
                dom.samples.some(
                  (sample) =>
                    sample.outcomeHandId === frame.payload.handId &&
                    sample.awardLines?.includes(`${name} 获得 ${award.amount}`),
                ),
                "visible award matches server allocation",
              ).toBe(true);
            }
          }
        }
      },
    };
    let gateFailed = false;
    try {
      await provide(session);
      if (info.status === "passed") await session.assert();
    } catch (error) {
      gateFailed = true;
      throw error;
    } finally {
      const doms = await Promise.all(
        players.map((player) => domEvidence(player.page).catch(() => null)),
      );
      const report = {
        scenario: info.title,
        retry: info.retry,
        status: gateFailed ? "failed" : info.status,
        runId: identity.runId,
        sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        seed:
          process.env.TEX_E2E_REAL_SEED ??
          (process.env.TEX_TIMELINE_SCENARIO === "split" ? "280835" : "280820"),
        worktreeDirty:
          execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
        browser: browser.version(),
        logs: session.logs(),
        players: players.map((player, index) => ({
          index,
          frames: player.frames,
          dom: doms[index],
          network: {
            operations: player.proxy.operations,
            samples: player.proxy.samples,
            errors: player.proxy.errors,
          },
          errors: player.errors,
          backgroundHands: [...(player.backgroundHands ?? [])],
        })),
      };
      const tokens = await Promise.all(
        players.map((player) =>
          player.page
            .evaluate(() => {
              const values: string[] = [];
              for (let index = 0; index < sessionStorage.length; index++) {
                const key = sessionStorage.key(index);
                if (key?.includes("player-token")) values.push(sessionStorage.getItem(key) ?? "");
              }
              return values;
            })
            .catch(() => []),
        ),
      );
      const safe = isSafeEvidence(report, [
        ...tokens.flat(),
        process.env.TEX_TEST_DATABASE_URL ?? "",
        process.env.DATABASE_URL ?? "",
      ]);
      if (!safe) gateFailed = true;
      await info.attach(safe ? "timeline-evidence" : "evidence-rejected", {
        body: safe ? JSON.stringify(report) : "Sensitive evidence refused export",
        contentType: safe ? "application/json" : "text/plain",
      });
      for (const [index, player] of players.entries()) {
        if (gateFailed || info.status !== "passed")
          await player.page
            .bringToFront()
            .then(() =>
              player.page.screenshot({
                path: info.outputPath(`player-${index}.png`),
                mask: [player.page.locator("[data-card-rank]")],
                fullPage: true,
                timeout: 5000,
              }),
            )
            .catch(() => undefined);
        const video = player.page.video();
        try {
          await player.context.close();
        } finally {
          await player.proxy.close();
        }
        const file = await video?.path();
        if (file !== undefined) videoFiles.push(file);
        if (!gateFailed && info.status === "passed") await video?.delete();
      }
      if (gateFailed || info.status !== "passed")
        for (const [index, path] of videoFiles.entries())
          await info.attach(`masked-player-${index}`, { path, contentType: "video/webm" });
      if (!safe) throw new Error("sensitive evidence refused export");
    }
  },
});
export { expect };
export type { TestInfo };
