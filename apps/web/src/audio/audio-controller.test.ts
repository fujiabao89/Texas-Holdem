import { describe, expect, it, vi } from "vitest";

import { createFakeClock } from "../../../../tests/support/fake-clock";

import { boardCardAudioCueDelayMs, flopCardAudioCueSpacingMs } from "../animations/timings";
import { AudioController, soundFor, type AudioAdapter } from "./audio-controller";

function fakeAdapter(overrides: Partial<AudioAdapter> = {}) {
  const played: string[] = [];
  return { played, adapter: { unlock: async () => undefined, play: async (url: string) => { played.push(url); }, ...overrides } satisfies AudioAdapter };
}

describe("AudioController", () => {
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
