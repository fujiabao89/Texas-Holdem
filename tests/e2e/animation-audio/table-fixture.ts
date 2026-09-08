import { resolve } from "node:path";

import type { Page, TestInfo } from "@playwright/test";

import { PROTOCOL_VERSION, ServerMessageSchema, type Card, type GameEvent, type GameSnapshot, type PlayerViewPatch, type RoomSnapshot, type ServerMessage } from "../../../packages/protocol/src";
import { expect } from "../fixtures/observability";

export const board: Card[] = [
  { rank: "10", suit: "SPADES" }, { rank: "J", suit: "SPADES" }, { rank: "Q", suit: "SPADES" },
  { rank: "K", suit: "SPADES" }, { rank: "A", suit: "SPADES" },
];

export function tableSnapshot(playerCount = 2, overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    snapshotVersion: 1, reason: "INITIAL", tournamentId: "tournament-38", sequence: "1", handId: "hand-38",
    tournamentStatus: "RUNNING", handPhase: "PREFLOP", blindLevel: { index: 0, smallBlind: 5, bigBlind: 10, ante: 0 },
    dealerSeat: 0, board: [], pots: [{ amount: 100, eligiblePlayerIds: ["player-1", "player-2"] }],
    currentActorPlayerId: "player-1", actionDeadline: null,
    players: Array.from({ length: playerCount }, (_, seat) => ({
      playerId: `player-${seat + 1}`, displayName: `玩家${seat + 1}`, seat, stack: 990, streetBet: 10, totalCommitted: 10,
      pokerStatus: "ACTIVE", hasHoleCards: true, revealedCards: [],
    })),
    viewer: {
      playerId: "player-1", role: "PLAYER", holeCards: [{ rank: "2", suit: "HEARTS" }, { rank: "3", suit: "HEARTS" }],
      legalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 5, canBet: false, minBetTo: null, canRaise: true, minRaiseTo: 20, maxRaiseTo: 990, canAllIn: true, allInTo: 1000 },
      timeBankRemainingMs: 0,
    }, rankings: [], ...overrides,
  };
}

export function reveal(playerId: "player-1" | "player-2"): Extract<GameEvent, { type: "PLAYER_REVEALED" }> {
  return {
    type: "PLAYER_REVEALED",
    payload: {
      playerId, seat: playerId === "player-1" ? 0 : 1,
      cards: playerId === "player-1" ? [{ rank: "2", suit: "HEARTS" }, { rank: "3", suit: "HEARTS" }] : [{ rank: "4", suit: "CLUBS" }, { rank: "5", suit: "CLUBS" }],
      handRank: { category: "STRAIGHT_FLUSH", tiebreakRanks: ["A"], label: "皇家同花顺", bestFiveCards: board },
    },
  };
}

export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date("2026-09-05T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-05T00:00:01Z"));
}

/** Wire-only UI fixture. Never imports or mutates the browser's projection store. */
export async function installTable(page: Page, initialGame = tableSnapshot()) {
  const room: RoomSnapshot = {
    snapshotVersion: 1, roomId: "room-38", roomRevision: "1", status: "IN_GAME", inviteCode: "ABC234", hostPlayerId: "player-1",
    config: { maxPlayers: initialGame.players.length, startingStack: 1000, smallBlind: 5, bigBlind: 10, blindMode: "fixed", blindStructure: [{ smallBlind: 5, bigBlind: 10 }], actionTime: "UNLIMITED", timeBank: 0 },
    activeTournamentId: initialGame.tournamentId,
    players: initialGame.players.map(({ playerId, displayName, seat }) => ({ playerId, displayName, seat, ready: true, connectionStatus: "CONNECTED", pokerStatus: "ACTIVE" })),
  };
  await page.addInitScript(() => {
    sessionStorage.setItem("texas-holdem:player-token:room-38", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    sessionStorage.setItem("texas-holdem:player-id:room-38", "player-1");
  });
  let latest = initialGame;
  let sendMessage: ((message: ServerMessage) => void) | undefined;
  const commands: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  await page.routeWebSocket("/api/v1/ws", (socket) => {
    sendMessage = (message) => socket.send(JSON.stringify(ServerMessageSchema.parse(message)));
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> };
      commands.push(command);
      if (command.type === "AUTHENTICATE") {
        sendMessage!({ type: "RECONNECT_RESULT", protocolVersion: PROTOCOL_VERSION, serverTime: 0, payload: {
          connectionId: "connection-38", resumed: true, tookOver: false, roomSnapshot: room, gameSnapshot: latest,
        } });
      }
      if (command.type === "REQUEST_SNAPSHOT") sendMessage!({ type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: Number(latest.sequence), payload: { ...latest, reason: "RESYNC" } });
    });
  });
  return {
    commands,
    async open() {
      await page.goto("/room/room-38/table");
      await expect(page.locator("[data-seat]")).toHaveCount(initialGame.players.length);
    },
    event(event: GameEvent, patch: PlayerViewPatch = {}) {
      if (sendMessage === undefined) throw new Error("Open the table before sending events");
      const sequence = String(BigInt(latest.sequence) + 1n);
      const players = latest.players.map((player) => ({ ...player, ...patch.players?.find((next) => next.playerId === player.playerId) }));
      latest = { ...latest, ...patch, sequence, players, viewer: { ...latest.viewer, ...patch.viewer } };
      sendMessage({ type: "GAME_EVENT", protocolVersion: PROTOCOL_VERSION, serverTime: Number(sequence), payload: {
        tournamentId: latest.tournamentId, handId: latest.handId, sequence, event, patch,
      } });
    },
    snapshot() {
      if (sendMessage === undefined) throw new Error("Open the table before sending a Snapshot");
      sendMessage({ type: "GAME_SNAPSHOT", protocolVersion: PROTOCOL_VERSION, serverTime: Number(latest.sequence), payload: { ...latest, reason: "RESYNC" } });
    },
  };
}

export async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

export async function installAudioProbe(page: Page, failure: "none" | "autoplay" | "play" | "load" = "none"): Promise<void> {
  await page.addInitScript((mode) => {
    const probe = { constructions: [] as string[], played: [] as string[], paused: 0 };
    Object.defineProperty(window, "tex38Audio", { value: probe, configurable: true });
    // Deliberately inject browser media failures; this does not assert actual
    // codec support, acoustic quality, or real-device autoplay policy.
    class TestAudio extends EventTarget {
      src: string;
      preload = "auto";
      muted = false;
      currentTime = 0;
      volume = 1;
      playbackRate = 1;
      constructor(src: string) {
        super(); this.src = src; probe.constructions.push(src);
        if (mode === "load" && !src.includes("double-knock")) throw new DOMException("Injected local media load failure", "NotSupportedError");
      }
      play(): Promise<void> {
        if (mode === "autoplay") return Promise.reject(new DOMException("Injected autoplay denial", "NotAllowedError"));
        if (!this.muted) probe.played.push(this.src);
        if (!this.muted && mode === "play") return Promise.reject(new DOMException("Injected playback failure", "NotSupportedError"));
        return Promise.resolve();
      }
      pause(): void { probe.paused += 1; }
      removeAttribute(name: string): void { if (name === "src") this.src = ""; }
      load(): void { /* No remote media in the deterministic failure fixture. */ }
    }
    Object.defineProperty(window, "Audio", { value: TestAudio, configurable: true });
  }, failure);
}

export async function audioProbe(page: Page): Promise<{ constructions: string[]; played: string[]; paused: number }> {
  return page.evaluate(() => (window as unknown as { tex38Audio: { constructions: string[]; played: string[]; paused: number } }).tex38Audio);
}

/** Keep successful visual evidence outside Playwright's next-run cleanup. */
export async function captureTableEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = resolve("output", "playwright", `TEX-38-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
