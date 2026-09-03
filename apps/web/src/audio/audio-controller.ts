import type { GameEvent } from "@texas-holdem/protocol";

import { boardCardAudioCueDelayMs, flopCardAudioCueSpacingMs } from "../animations/timings";

export type SoundName =
  | "deal"
  | "board"
  | "check"
  | "blind"
  | "call"
  | "bet"
  | "raise"
  | "fold"
  | "allIn"
  | "pot"
  | "finish";

export interface AudioAdapter {
  unlock(): Promise<void>;
  play(url: string, options?: AudioPlayOptions): Promise<void>;
  preload?(urls: readonly string[]): void;
  stop?(): void;
}

export interface AudioPlayOptions {
  readonly volume?: number;
  readonly playbackRate?: number;
}

export interface AudioClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AudioChannel {
  claim(owner: object, stop: () => void): void;
  release(owner: object): void;
}

/** Keeps independently mounted table controllers on one in-page channel. */
export function createExclusiveAudioChannel(): AudioChannel {
  let active: { readonly owner: object; readonly stop: () => void } | null = null;
  return {
    claim(owner, stop) {
      if (active?.owner !== owner) {
        const previous = active;
        active = null;
        previous?.stop();
      }
      active = { owner, stop };
    },
    release(owner) {
      if (active?.owner === owner) active = null;
    },
  };
}

const soundUrls: Readonly<Record<SoundName, string>> = {
  deal: "/audio/kenney-casino-deal-soft.mp3",
  board: "/audio/kenney-casino-board-soft.mp3",
  check: "/audio/kenney-impact-table-double-knock.mp3",
  blind: "/audio/kenney-casino-chip-lay.mp3",
  call: "/audio/kenney-casino-chip-call.mp3",
  bet: "/audio/kenney-casino-chip-bet.mp3",
  raise: "/audio/kenney-casino-chip-raise-scatter.mp3",
  fold: "/audio/kenney-casino-card-fold.mp3",
  allIn: "/audio/kenney-casino-chip-all-in-scatter.mp3",
  pot: "/audio/kenney-casino-chip-pot.mp3",
  finish: "/audio/kenney-casino-chip-finish.mp3",
};

/** Local-only audio facade. All browser failures are deliberately non-fatal. */
export class AudioController {
  private enabled = true;
  private foreground = true;
  private unlocked = false;
  private playing = false;
  private playGeneration = 0;
  private readonly pending = new Set<unknown>();

  constructor(
    private readonly adapter: AudioAdapter,
    private readonly clock: AudioClock = browserClock,
    private readonly channel?: AudioChannel,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
  }
  isEnabled(): boolean { return this.enabled; }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground) this.cancelPending();
  }

  async unlock(): Promise<void> {
    try { await this.adapter.unlock(); this.unlocked = true; }
    catch { /* autoplay policies are a silent visual-only fallback */ }
  }

  preloadCritical(): void {
    this.adapter.preload?.([...new Set(Object.values(soundUrls))]);
  }

  playEvent(event: GameEvent): void {
    const sound = soundFor(event);
    if (!this.enabled || !this.foreground || !this.unlocked || sound === null) return;
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
    this.stopActivePlayback();
  }

  private schedule(sound: SoundName, delayMs: number, options?: AudioPlayOptions): void {
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle);
      this.play(sound, options);
    }, delayMs);
    this.pending.add(handle);
  }

  private play(sound: SoundName, options?: AudioPlayOptions): void {
    if (!this.enabled || !this.foreground || !this.unlocked) return;
    if (this.playing) this.stopActivePlayback();
    this.channel?.claim(this, () => this.stopActivePlayback());
    this.playing = true;
    const generation = ++this.playGeneration;
    void this.adapter.play(soundUrls[sound], options).then(
      () => {
        if (generation === this.playGeneration) {
          this.playing = false;
          this.channel?.release(this);
        }
      },
      () => {
        if (generation === this.playGeneration) {
          this.playing = false;
          this.channel?.release(this);
        }
      },
    );
  }

  private stopActivePlayback(): void {
    this.playGeneration += 1;
    this.playing = false;
    this.adapter.stop?.();
    this.channel?.release(this);
  }
}

export function soundFor(event: GameEvent): SoundName | null {
  switch (event.type) {
    case "DEAL_HOLE_CARD": return "deal";
    case "FLOP_DEALT": case "TURN_DEALT": case "RIVER_DEALT": return "board";
    case "PLAYER_CHECKED": return "check";
    case "BLIND_POSTED": return "blind";
    case "PLAYER_CALLED": return "call";
    case "PLAYER_BET": return "bet";
    case "PLAYER_RAISED": return "raise";
    case "PLAYER_FOLDED": return "fold";
    case "PLAYER_ALL_IN": return "allIn";
    case "POT_AWARDED": return "pot";
    case "TOURNAMENT_FINISHED": return "finish";
    default: return null;
  }
}

export function createBrowserAudioAdapter(): AudioAdapter {
  const elements = new Map<string, HTMLAudioElement>();
  let active: { readonly element: HTMLAudioElement; readonly settle: (error?: unknown) => void } | null = null;
  const elementFor = (url: string): HTMLAudioElement => {
    const existing = elements.get(url);
    if (existing !== undefined) return existing;
    const created = new Audio(url);
    created.preload = "auto";
    elements.set(url, created);
    return created;
  };
  const stop = (): void => {
    if (active === null) return;
    const { element, settle } = active;
    element.pause();
    element.currentTime = 0;
    settle();
  };
  return {
    async unlock() {
      // Creating and immediately pausing a local audio element is enough to
      // bind subsequent playback to the user's gesture without remote audio.
      const audio = elementFor(soundUrls.check);
      audio.muted = true;
      try { await audio.play(); } finally { audio.pause(); audio.currentTime = 0; audio.muted = false; }
    },
    play(url, options = {}) {
      // The controller normally drops a cue while another is active. This
      // defensive stop also keeps the adapter exclusive if it is used alone.
      stop();
      const audio = elementFor(url);
      audio.pause();
      audio.currentTime = 0;
      audio.volume = options.volume ?? 0.8;
      audio.playbackRate = options.playbackRate ?? 1;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          if (active?.element === audio) active = null;
        };
        const settle = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve(); else reject(error);
        };
        const onEnded = (): void => settle();
        const onError = (): void => settle(new Error("local audio playback failed"));
        active = { element: audio, settle };
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        void audio.play().catch(settle);
      });
    },
    preload(urls) { for (const url of urls) elementFor(url); },
    stop,
  };
}

const browserClock: AudioClock = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as ReturnType<typeof window.setTimeout>),
};
