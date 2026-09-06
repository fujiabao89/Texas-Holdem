import { describe, expect, it, vi } from "vitest";
import type { GameEvent } from "@texas-holdem/protocol";

import { createFakeClock } from "../../../../tests/support/fake-clock";

import { boardCardAudioCueDelayMs, flopCardAudioCueSpacingMs } from "../animations/timings";
import { AudioController, createBrowserAudioAdapter, createExclusiveAudioChannel, soundFor, type AudioAdapter } from "./audio-controller";

function fakeAdapter(overrides: Partial<AudioAdapter> = {}) {
  const played: string[] = [];
  return { played, adapter: { unlock: async () => undefined, play: async (url: string) => { played.push(url); }, ...overrides } satisfies AudioAdapter };
}

describe("AudioController", () => {
  const check = { type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } } as const;
  const flop: GameEvent = { type: "FLOP_DEALT", payload: { cards: [
    { rank: "A", suit: "SPADES" }, { rank: "K", suit: "HEARTS" }, { rank: "Q", suit: "CLUBS" },
  ] } };

  it("unlocks synchronously, shares in-flight attempts, retries failures and remains idempotent", async () => {
    let reject: (error: Error) => void = () => undefined;
    const unlock = vi.fn(() => new Promise<void>((_resolve, rejectAttempt) => { reject = rejectAttempt; }));
    const audio = new AudioController(fakeAdapter({ unlock }).adapter);
    const first = audio.unlock();
    expect(unlock).toHaveBeenCalledOnce();
    expect(audio.unlock()).toBe(first);
    reject(new Error("autoplay denied"));
    await first;
    unlock.mockImplementation(async () => undefined);
    await audio.unlock();
    await audio.unlock();
    expect(unlock).toHaveBeenCalledTimes(2);
  });

  it("invalidates old unlock promises on dispose and can reactivate after Strict Mode cleanup", async () => {
    let completeOld: () => void = () => undefined;
    const unlock = vi.fn(() => new Promise<void>((resolve) => { completeOld = resolve; }));
    const dispose = vi.fn();
    const { adapter, played } = fakeAdapter({ unlock, dispose });
    const audio = new AudioController(adapter);
    const oldAttempt = audio.unlock();
    audio.dispose();
    audio.dispose();
    audio.activate();
    completeOld();
    await oldAttempt;
    audio.playEvent(check);
    expect(played).toEqual([]);
    unlock.mockImplementation(async () => undefined);
    await audio.unlock();
    audio.playEvent(check);
    expect(played).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("applies live volume with per-cue gain and cancels delayed sounds when volume reaches zero", async () => {
    const clock = createFakeClock();
    const play = vi.fn(() => new Promise<void>(() => undefined));
    const setVolume = vi.fn();
    const stop = vi.fn();
    const audio = new AudioController(fakeAdapter({ play, setVolume, stop }).adapter, clock);
    await audio.unlock();
    audio.setVolume(0.5);
    audio.playEvent(flop);
    clock.advance(boardCardAudioCueDelayMs + flopCardAudioCueSpacingMs);
    expect(play).toHaveBeenLastCalledWith(expect.any(String), { volume: 0.39, playbackRate: 1.03 });
    audio.setVolume(0.25);
    expect(setVolume).toHaveBeenLastCalledWith(0.195);
    audio.setVolume(0);
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(2_000);
    expect(play).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("plays collapsed events immediately without scheduling historical card sounds", async () => {
    const clock = createFakeClock();
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter, clock);
    await audio.unlock();
    audio.playEvent(flop, { immediate: true });
    expect(played).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(2_000);
    expect(played).toHaveLength(1);
  });

  it("coalesces repeated ordinary bursts but preserves distinct actions and all-in cues", async () => {
    const clock = createFakeClock();
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter, clock);
    await audio.unlock();
    audio.playEvent(check);
    audio.playEvent(check);
    expect(played).toHaveLength(1);
    const allIn = { type: "PLAYER_ALL_IN", payload: { ...check.payload, amount: 100, betTo: 100 } } as const;
    audio.playEvent(allIn);
    audio.playEvent(allIn);
    expect(played).toHaveLength(3);
    clock.advance(90);
    audio.playEvent(check);
    expect(played).toHaveLength(4);
  });

  it("preloads only critical local assets once and can preload again after disposal", () => {
    const preload = vi.fn();
    const audio = new AudioController(fakeAdapter({ preload }).adapter);
    expect(preload).not.toHaveBeenCalled();
    audio.preloadCritical();
    audio.preloadCritical();
    expect(preload).toHaveBeenCalledOnce();
    const urls = preload.mock.calls[0]?.[0] as string[];
    expect(urls).toHaveLength(5);
    expect(urls.every((url) => url.startsWith("/audio/"))).toBe(true);
    expect(urls).toContain("/audio/kenney-casino-chip-pot.mp3");
    audio.dispose();
    audio.activate();
    audio.preloadCritical();
    expect(preload).toHaveBeenCalledTimes(2);
  });

  it("waits for critical audio to finish before a current turn cue and discards obsolete notices", async () => {
    const clock = createFakeClock();
    let finish: () => void = () => undefined;
    const play = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const audio = new AudioController(fakeAdapter({ play }).adapter, clock);
    await audio.unlock();
    audio.playEvent(check);
    audio.playTableCue("yourTurn");
    expect(play).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    expect(play).toHaveBeenLastCalledWith(expect.stringContaining("board-soft"), { volume: 0.8 * 0.7, playbackRate: 1.6 });
    audio.playTableCue("blindLevel");
    audio.cancelTableCue();
    finish();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(2);
    clock.advance(90);
    audio.playEvent(check);
    audio.playTableCue("yourTurn");
    clock.advance(901);
    finish();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(3);
  });

  it.each(["STRAIGHT", "FLUSH", "FULL_HOUSE", "FOUR_OF_A_KIND", "STRAIGHT_FLUSH"] as const)("uses only the server's winning %s for its non-verbal cue", async (category) => {
    const clock = createFakeClock();
    const play = vi.fn(async () => undefined);
    const audio = new AudioController(fakeAdapter({ play }).adapter, clock);
    await audio.unlock();
    const winningHandRank = { category, tiebreakRanks: ["A" as const], label: category, bestFiveCards: Array.from({ length: 5 }, () => ({ rank: "A" as const, suit: "SPADES" as const })) };
    audio.playEvent({ type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 100, awards: [{ playerId: "p", amount: 100 }], winningHandRank } });
    expect(play).toHaveBeenCalledOnce();
    clock.advance(240);
    expect(play).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenLastCalledWith(expect.stringContaining("chip-pot"), { volume: 0.576, playbackRate: expect.any(Number) });
    audio.cancelPending();
    audio.playEvent({ type: "POT_AWARDED", payload: { potIndex: 0, potAmount: 100, awards: [{ playerId: "p", amount: 100 }], winningHandRank: null } });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("constructs the browser adapter during SSR without accessing Audio", () => {
    expect(() => createBrowserAudioAdapter()).not.toThrow();
  });
  it("uses local files only and respects the global switch", async () => {
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter);
    await audio.unlock();
    audio.playEvent({ type: "PLAYER_BET", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET", amount: 5, betTo: 5 } });
    await Promise.resolve();
    expect(played[0]).toMatch(/^\/audio\/kenney-/);
    audio.setEnabled(false);
    audio.playEvent({ type: "PLAYER_FOLDED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    await Promise.resolve();
    expect(played).toHaveLength(1);
  });

  it("silently degrades when autoplay unlock or playback fails", async () => {
    const { adapter, played } = fakeAdapter({ unlock: async () => { throw new Error("blocked"); }, play: async () => { throw new Error("blocked"); } });
    const audio = new AudioController(adapter);
    await expect(audio.unlock()).resolves.toBeUndefined();
    audio.playEvent({ type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    await Promise.resolve();
    expect(played).toEqual([]);
    expect(soundFor({ type: "BURN_CARD", payload: { street: "FLOP" } })).toBeNull();
  });

  it("preempts the current cue instead of overlapping or dropping the next action", async () => {
    let finishCurrent: (() => void) | undefined;
    const play = vi.fn(() => new Promise<void>((resolve) => { finishCurrent = resolve; }));
    const stop = vi.fn(() => finishCurrent?.());
    const audio = new AudioController({ unlock: async () => undefined, play, stop });
    await audio.unlock();

    audio.playEvent({ type: "PLAYER_BET", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET", amount: 5, betTo: 5 } });
    audio.playEvent({ type: "PLAYER_FOLDED", payload: { playerId: "q", seat: 1, source: "HUMAN_SOCKET" } });
    expect(play).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preempts audio owned by another mounted table controller", async () => {
    const channel = createExclusiveAudioChannel();
    const firstStop = vi.fn();
    const secondPlay = vi.fn(() => new Promise<void>(() => undefined));
    const first = new AudioController({ unlock: async () => undefined, play: () => new Promise<void>(() => undefined), stop: firstStop }, undefined, channel);
    const second = new AudioController({ unlock: async () => undefined, play: secondPlay }, undefined, channel);
    await first.unlock();
    await second.unlock();

    first.playEvent({ type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    second.playEvent({ type: "PLAYER_RAISED", payload: { playerId: "q", seat: 1, source: "HUMAN_SOCKET", amount: 10, raiseTo: 20, isFullRaise: true } });

    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondPlay).toHaveBeenCalledOnce();
  });

  it("does not let an informational reminder preempt another table's card sequence", async () => {
    const clock = createFakeClock();
    const channel = createExclusiveAudioChannel();
    const firstStop = vi.fn();
    const firstPlay = vi.fn(() => new Promise<void>(() => undefined));
    const secondPlay = vi.fn(() => new Promise<void>(() => undefined));
    const first = new AudioController(fakeAdapter({ play: firstPlay, stop: firstStop }).adapter, clock, channel);
    const second = new AudioController(fakeAdapter({ play: secondPlay }).adapter, clock, channel);
    await first.unlock();
    await second.unlock();
    first.playEvent(flop);
    clock.advance(boardCardAudioCueDelayMs);
    second.playTableCue("yourTurn");
    expect(firstStop).not.toHaveBeenCalled();
    expect(secondPlay).not.toHaveBeenCalled();

    // A real event takes ownership, cancelling the old table's remaining
    // scheduled cards so they cannot steal the channel back later.
    second.playEvent(check);
    expect(firstStop).toHaveBeenCalledOnce();
    clock.advance(2_000);
    expect(firstPlay).toHaveBeenCalledOnce();
    expect(secondPlay).toHaveBeenCalledOnce();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("retries revoked autoplay on a later gesture without replaying deferred cues", async () => {
    const clock = createFakeClock();
    const unlock = vi.fn(async () => undefined);
    const play = vi.fn(async () => undefined);
    const audio = new AudioController(fakeAdapter({ play, unlock }).adapter, clock);
    await audio.unlock();
    play.mockRejectedValueOnce(Object.assign(new Error("permission revoked"), { name: "NotAllowedError" }));
    audio.playEvent(flop);
    clock.advance(boardCardAudioCueDelayMs);
    audio.playTableCue("yourTurn");
    await Promise.resolve();
    expect(clock.pendingTimers()).toBe(0);
    audio.playEvent(check);
    expect(play).toHaveBeenCalledOnce();
    await audio.unlock();
    expect(unlock).toHaveBeenCalledTimes(2);
    clock.advance(2_000);
    expect(play).toHaveBeenCalledOnce();
    audio.playEvent(check);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("silently settles a failed cue without playing the reminder waiting behind it", async () => {
    const clock = createFakeClock();
    const play = vi.fn(async () => { throw new Error("missing local audio"); });
    const audio = new AudioController(fakeAdapter({ play }).adapter, clock);
    await audio.unlock();
    audio.playEvent(check);
    audio.playTableCue("yourTurn");
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
    clock.advance(100);
    expect(() => audio.playEvent(check)).not.toThrow();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("invalidates a waiting reminder on a presentation barrier and at its freshness deadline", async () => {
    const clock = createFakeClock();
    let finish: () => void = () => undefined;
    const play = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const audio = new AudioController(fakeAdapter({ play }).adapter, clock);
    await audio.unlock();
    audio.playEvent(check);
    audio.playTableCue("yourTurn");
    const finishOld = finish;
    audio.cancelPending();
    finishOld();
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
    audio.playEvent(check);
    audio.playTableCue("blindLevel");
    clock.advance(900);
    finish();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("stops and suppresses cues while its table is in a background tab", async () => {
    const { adapter, played } = fakeAdapter({ stop: vi.fn() });
    const audio = new AudioController(adapter);
    await audio.unlock();
    audio.playEvent({ type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    audio.setForeground(false);
    audio.playEvent({ type: "PLAYER_FOLDED", payload: { playerId: "q", seat: 1, source: "HUMAN_SOCKET" } });
    await Promise.resolve();
    expect(played).toHaveLength(1);
  });

  it("stops an active cue when sound is disabled", async () => {
    const stop = vi.fn();
    const audio = new AudioController({
      unlock: async () => undefined,
      play: () => new Promise<void>(() => undefined),
      stop,
    });
    await audio.unlock();
    audio.playEvent({ type: "PLAYER_CHECKED", payload: { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } });
    audio.setEnabled(false);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses a distinct local sound for every player action", async () => {
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter);
    await audio.unlock();
    const actor = { playerId: "p", seat: 0, source: "HUMAN_SOCKET" } as const;
    const events = [
      { type: "PLAYER_CHECKED", payload: actor },
      { type: "PLAYER_CALLED", payload: { ...actor, amount: 5, betTo: 5 } },
      { type: "PLAYER_BET", payload: { ...actor, amount: 10, betTo: 10 } },
      { type: "PLAYER_RAISED", payload: { ...actor, amount: 10, raiseTo: 20, isFullRaise: true } },
      { type: "PLAYER_ALL_IN", payload: { ...actor, amount: 100, betTo: 100 } },
      { type: "PLAYER_FOLDED", payload: actor },
    ] as const;

    for (const event of events) {
      audio.playEvent(event);
      await Promise.resolve();
    }

    expect(played).toHaveLength(events.length);
    expect(new Set(played).size).toBe(events.length);
    expect(played[0]).toContain("table-double-knock");
    expect(played[3]).toContain("raise-scatter");
    expect(played[4]).toContain("all-in-scatter");
  });

  it("uses a paced local three-cue sequence for one authoritative flop event", async () => {
    const clock = createFakeClock();
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter, clock);
    await audio.unlock();
    audio.playEvent({ type: "FLOP_DEALT", payload: { cards: [
      { rank: "A", suit: "SPADES" }, { rank: "K", suit: "HEARTS" }, { rank: "Q", suit: "CLUBS" },
    ] } });
    await Promise.resolve();
    expect(played).toHaveLength(0);
    clock.advance(boardCardAudioCueDelayMs - 1);
    await Promise.resolve();
    expect(played).toHaveLength(0);
    clock.advance(1);
    await Promise.resolve();
    expect(played).toHaveLength(1);
    clock.advance(flopCardAudioCueSpacingMs);
    await Promise.resolve();
    expect(played).toHaveLength(2);
    clock.advance(flopCardAudioCueSpacingMs);
    await Promise.resolve();
    expect(played).toHaveLength(3);
  });

  it("cancels queued card cues when sound is disabled", async () => {
    const clock = createFakeClock();
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter, clock);
    await audio.unlock();
    audio.playEvent({ type: "FLOP_DEALT", payload: { cards: [
      { rank: "A", suit: "SPADES" }, { rank: "K", suit: "HEARTS" }, { rank: "Q", suit: "CLUBS" },
    ] } });
    audio.setEnabled(false);
    clock.advance(2_000);
    await Promise.resolve();
    expect(played).toHaveLength(0);
  });

  it("plays a turn cue at the same landing point as its visual card", async () => {
    const clock = createFakeClock();
    const { adapter, played } = fakeAdapter();
    const audio = new AudioController(adapter, clock);
    await audio.unlock();
    audio.playEvent({ type: "TURN_DEALT", payload: { card: { rank: "A", suit: "SPADES" } } });
    clock.advance(boardCardAudioCueDelayMs - 1);
    await Promise.resolve();
    expect(played).toHaveLength(0);
    clock.advance(1);
    await Promise.resolve();
    expect(played).toHaveLength(1);
  });
});
