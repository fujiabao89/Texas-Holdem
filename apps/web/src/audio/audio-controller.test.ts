import { describe, expect, it } from "vitest";

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
});
