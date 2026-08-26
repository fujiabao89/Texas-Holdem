import type { GameEvent } from "@texas-holdem/protocol";

import { boardCardAudioCueDelayMs, flopCardAudioCueSpacingMs } from "../animations/timings";

export type SoundName = "deal" | "board" | "check" | "bet" | "fold" | "allIn" | "pot" | "turn" | "finish";

export interface AudioAdapter {
  unlock(): Promise<void>;
  play(url: string, options?: AudioPlayOptions): Promise<void>;
  preload?(urls: readonly string[]): void;
}

export interface AudioPlayOptions {
  readonly volume?: number;
  readonly playbackRate?: number;
}

export interface AudioClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const soundUrls: Readonly<Record<SoundName, string>> = {
  deal: "/audio/kenney-casino-card-slide.mp3",
  board: "/audio/kenney-casino-card-place.mp3",
  check: "/audio/kenney-casino-card-place.mp3",
  bet: "/audio/kenney-casino-chip-lay.mp3",
  fold: "/audio/kenney-casino-card-slide.mp3",
  allIn: "/audio/kenney-casino-chip-lay.mp3",
  pot: "/audio/kenney-casino-chip-lay.mp3",
  turn: "/audio/kenney-casino-card-place.mp3",
  finish: "/audio/kenney-casino-chip-lay.mp3",
};

/** Local-only audio facade. All browser failures are deliberately non-fatal. */
export class AudioController {
  private enabled = true;
  private unlocked = false;
  private readonly pending = new Set<unknown>();

  constructor(private readonly adapter: AudioAdapter, private readonly clock: AudioClock = browserClock) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
  }
  isEnabled(): boolean { return this.enabled; }

  async unlock(): Promise<void> {
    try { await this.adapter.unlock(); this.unlocked = true; }
    catch { /* autoplay policies are a silent visual-only fallback */ }
  }

  preloadCritical(): void {
    this.adapter.preload?.([...new Set(Object.values(soundUrls))]);
  }

  playEvent(event: GameEvent): void {
    const sound = soundFor(event);
    if (!this.enabled || !this.unlocked || sound === null) return;
    // Card sounds land with the in-slot flip, not when a queued Event starts.
    // A flop remains one authoritative event; the three local cues only follow
    // the presentation timing of its three cards.
    if (event.type === "FLOP_DEALT") {
      this.schedule("board", boardCardAudioCueDelayMs);
      this.schedule("board", boardCardAudioCueDelayMs + flopCardAudioCueSpacingMs, { volume: 0.78, playbackRate: 1.03 });
      this.schedule("board", boardCardAudioCueDelayMs + flopCardAudioCueSpacingMs * 2, { volume: 0.72, playbackRate: 1.06 });
      return;
    }
    if (event.type === "TURN_DEALT" || event.type === "RIVER_DEALT") {
      this.schedule("board", boardCardAudioCueDelayMs);
      return;
    }
    this.play(sound);
  }

  cancelPending(): void {
    for (const handle of this.pending) this.clock.clearTimeout(handle);
    this.pending.clear();
  }

  private schedule(sound: SoundName, delayMs: number, options?: AudioPlayOptions): void {
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle);
      this.play(sound, options);
    }, delayMs);
    this.pending.add(handle);
  }

  private play(sound: SoundName, options?: AudioPlayOptions): void {
    if (!this.enabled || !this.unlocked) return;
    void this.adapter.play(soundUrls[sound], options).catch(() => undefined);
  }
}

export function soundFor(event: GameEvent): SoundName | null {
  switch (event.type) {
    case "DEAL_HOLE_CARD": return "deal";
    case "FLOP_DEALT": case "TURN_DEALT": case "RIVER_DEALT": return "board";
    case "PLAYER_CHECKED": return "check";
    case "BLIND_POSTED": case "PLAYER_CALLED": case "PLAYER_BET": case "PLAYER_RAISED": return "bet";
    case "PLAYER_FOLDED": return "fold";
    case "PLAYER_ALL_IN": return "allIn";
    case "POT_AWARDED": return "pot";
    case "TOURNAMENT_FINISHED": return "finish";
    default: return null;
  }
}

export function createBrowserAudioAdapter(): AudioAdapter {
  const pools = new Map<string, HTMLAudioElement[]>();
  const nextVoice = new Map<string, number>();
  const voices = (url: string): HTMLAudioElement[] => {
    const existing = pools.get(url);
    if (existing !== undefined) return existing;
    // Reusing a small voice pool avoids re-decoding the same short clip while
    // cards arrive in a burst, without sharing state with the game protocol.
    const created = Array.from({ length: 4 }, () => {
      const audio = new Audio(url);
      audio.preload = "auto";
      return audio;
    });
    pools.set(url, created);
    return created;
  };
  return {
    async unlock() {
      // Creating and immediately pausing a local audio element is enough to
      // bind subsequent playback to the user's gesture without remote audio.
      const audio = voices(soundUrls.check)[0]!;
      audio.muted = true;
      try { await audio.play(); } finally { audio.pause(); audio.currentTime = 0; audio.muted = false; }
    },
    async play(url, options = {}) {
      const pool = voices(url);
      const index = nextVoice.get(url) ?? 0;
      const audio = pool[index % pool.length]!;
      nextVoice.set(url, index + 1);
      audio.pause();
      audio.currentTime = 0;
      audio.volume = options.volume ?? 0.8;
      audio.playbackRate = options.playbackRate ?? 1;
      await audio.play();
    },
    preload(urls) { for (const url of urls) voices(url); },
  };
}

const browserClock: AudioClock = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as ReturnType<typeof window.setTimeout>),
};
