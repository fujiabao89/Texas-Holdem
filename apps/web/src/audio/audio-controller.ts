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

export type TableCue = "yourTurn" | "blindLevel";

type WinningCategory = NonNullable<Extract<GameEvent, { type: "POT_AWARDED" }>["payload"]["winningHandRank"]>["category"];

// These are playback variations of the existing licensed local samples, not
// speech or a client-side hand evaluation. Other ranks keep the usual pot cue.
const winningRankRates: Partial<Record<WinningCategory, number>> = {
  STRAIGHT: 1.08,
  FLUSH: 1.22,
  FULL_HOUSE: 1.36,
  FOUR_OF_A_KIND: 1.52,
  STRAIGHT_FLUSH: 1.7,
};

export interface AudioAdapter {
  unlock(): Promise<void>;
  play(url: string, options?: AudioPlayOptions): Promise<void>;
  preload?(urls: readonly string[]): void;
  stop?(): void;
  setVolume?(volume: number): void;
  dispose?(): void;
}

export interface AudioPlayOptions {
  readonly volume?: number;
  readonly playbackRate?: number;
}

export interface AudioClock {
  now?(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AudioChannel {
  isAvailable(owner: object): boolean;
  claim(owner: object, stop: () => void): void;
  release(owner: object): void;
}

/** Keeps independently mounted table controllers on one in-page channel. */
export function createExclusiveAudioChannel(): AudioChannel {
  let active: { readonly owner: object; readonly stop: () => void } | null = null;
  return {
    isAvailable: (owner) => active === null || active.owner === owner,
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
  private volume = 0.8;
  private activeCueGain = 1;
  private foreground = true;
  private unlocked = false;
  private unlocking: Promise<void> | null = null;
  private disposed = false;
  private lifecycle = 0;
  private preloaded = false;
  private playing = false;
  private playGeneration = 0;
  private lastOrdinaryCue: { readonly sound: SoundName; readonly time: number } | null = null;
  private tableCue: { readonly cue: TableCue; readonly expiresAt: number } | null = null;
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

  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.8;
    if (this.volume === 0) this.cancelPending();
    try { this.adapter.setVolume?.(this.volume * this.activeCueGain); }
    catch { /* a media failure cannot affect the preference or the table */ }
  }

  /** Reusable after effect cleanup/setup in React Strict Mode. */
  activate(): void { this.disposed = false; }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground) this.cancelPending();
  }

  unlock(): Promise<void> {
    if (this.disposed || this.unlocked) return Promise.resolve();
    if (this.unlocking !== null) return this.unlocking;
    const lifecycle = this.lifecycle;
    try {
      // Invoke synchronously inside the pointer/key gesture; deferring this
      // call to a microtask can lose the browser's user-activation permission.
      this.unlocking = this.adapter.unlock().then(() => {
        if (!this.disposed && lifecycle === this.lifecycle) this.unlocked = true;
      }).catch(() => {
        // The next user gesture can retry after an autoplay rejection.
      }).finally(() => {
        if (lifecycle === this.lifecycle) this.unlocking = null;
      });
      return this.unlocking;
    } catch { return Promise.resolve(); }
  }

  preloadCritical(): void {
    if (this.disposed || this.preloaded || !this.enabled || !this.foreground) return;
    try {
      this.adapter.preload?.([soundUrls.deal, soundUrls.board, soundUrls.allIn, soundUrls.pot, soundUrls.blind]);
      this.preloaded = true;
    } catch { /* preload is an optional performance hint */ }
  }

  playEvent(event: GameEvent, options: { readonly immediate?: boolean } = {}): void {
    const sound = soundFor(event);
    if (!this.canPlay() || sound === null) return;
    const rankRate = event.type === "POT_AWARDED" && event.payload.winningHandRank !== null
      ? winningRankRates[event.payload.winningHandRank.category]
      : undefined;
    if (options.immediate) {
      // Reduced motion still has audio: a collapsed flop gets one clear cue,
      // without scheduling three sounds for card transitions that do not run.
      this.play(sound, rankRate === undefined ? undefined : { volume: 0.88, playbackRate: rankRate });
      return;
    }
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
    if (rankRate !== undefined) this.schedule("pot", 240, { volume: 0.72, playbackRate: rankRate });
  }

  /** Current canonical notices may wait briefly for a gap, never preempt a card or payout. */
  playTableCue(cue: TableCue): void {
    if (!this.canPlay()) return;
    this.tableCue = { cue, expiresAt: this.now() + 900 };
    this.flushTableCue();
  }

  cancelTableCue(): void { this.tableCue = null; }

  cancelPending(): void {
    for (const handle of this.pending) this.clock.clearTimeout(handle);
    this.pending.clear();
    this.cancelTableCue();
    this.lastOrdinaryCue = null;
    this.stopActivePlayback();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle += 1;
    this.unlocked = false;
    this.unlocking = null;
    this.preloaded = false;
    this.cancelPending();
    try { this.adapter.dispose?.(); } catch { /* optional media cleanup */ }
  }

  private canPlay(): boolean {
    return !this.disposed && this.enabled && this.volume > 0 && this.foreground && this.unlocked;
  }

  private now(): number { return this.clock.now?.() ?? Date.now(); }

  private flushTableCue(): void {
    if (this.tableCue === null || this.playing || this.pending.size > 0) return;
    const { cue, expiresAt } = this.tableCue;
    this.tableCue = null;
    if (this.now() >= expiresAt || !this.canPlay() || this.channel?.isAvailable(this) === false) return;
    this.play(cue === "yourTurn" ? "board" : "blind", {
      volume: cue === "yourTurn" ? 0.7 : 0.65,
      playbackRate: cue === "yourTurn" ? 1.6 : 1.3,
    });
  }

  private schedule(sound: SoundName, delayMs: number, options?: AudioPlayOptions): void {
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle);
      this.play(sound, options);
    }, delayMs);
    this.pending.add(handle);
  }

  private play(sound: SoundName, options?: AudioPlayOptions): void {
    if (!this.canPlay()) return;
    // Repeated ordinary cues in a burst may coalesce, but card/All-in/payout
    // cues always preempt immediately and different actions retain their tone.
    if (options?.playbackRate === undefined && (sound === "check" || sound === "call" || sound === "bet" || sound === "raise" || sound === "fold" || sound === "blind")) {
      const time = this.now();
      if (this.lastOrdinaryCue?.sound === sound && time - this.lastOrdinaryCue.time < 90) return;
      this.lastOrdinaryCue = { sound, time };
    }
    if (this.playing) this.stopActivePlayback();
    // A newly mounted table takes ownership of the complete cue sequence;
    // the old table must not reclaim the channel with a delayed card sound.
    this.channel?.claim(this, () => this.cancelPending());
    this.playing = true;
    this.activeCueGain = options?.volume ?? 1;
    const generation = ++this.playGeneration;
    const settle = (): void => {
      if (generation === this.playGeneration) {
        this.playing = false;
        this.channel?.release(this);
        this.flushTableCue();
      }
    };
    const fail = (error: unknown): void => {
      if (generation !== this.playGeneration) return;
      this.cancelTableCue();
      if (typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError") {
        // Browsers can revoke playback permission after a media interruption.
        // Retry only on the next user gesture and never replay the missed cue.
        this.unlocked = false;
        this.cancelPending();
      } else settle();
    };
    try {
      void this.adapter.play(soundUrls[sound], { ...options, volume: this.volume * this.activeCueGain }).then(settle, fail);
    } catch (error) { fail(error); }
  }

  private stopActivePlayback(): void {
    this.playGeneration += 1;
    this.playing = false;
    try { this.adapter.stop?.(); } catch { /* detached media element */ }
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

export function createBrowserAudioAdapter(clock: AudioClock = browserClock): AudioAdapter {
  const elements = new Map<string, HTMLAudioElement>();
  let active: { readonly element: HTMLAudioElement; readonly settle: (error?: unknown) => void } | null = null;
  let cancelUnlock: (() => void) | null = null;
  const elementFor = (url: string): HTMLAudioElement => {
    const existing = elements.get(url);
    if (existing !== undefined) return existing;
    const created = new Audio(url);
    created.preload = "auto";
    elements.set(url, created);
    return created;
  };
  const stop = (): void => {
    cancelUnlock?.();
    if (active === null) return;
    const { element, settle } = active;
    try { element.pause(); element.currentTime = 0; }
    finally { settle(); }
  };
  return {
    unlock() {
      cancelUnlock?.();
      const audio = elementFor(soundUrls.check);
      audio.muted = true;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          if (watchdog !== undefined) clock.clearTimeout(watchdog);
          cancelUnlock = null;
          try { audio.pause(); audio.currentTime = 0; }
          catch { /* a detached element still needs to release the attempt */ }
          audio.muted = false;
          if (error === undefined) resolve(); else reject(error);
        };
        cancelUnlock = () => settle(new Error("local audio unlock cancelled"));
        const watchdog = clock.setTimeout(() => settle(new Error("local audio unlock timed out")), 5_000);
        // Start synchronously within the gesture, then silence the probe as
        // soon as playback is permitted. No sound is queued for later replay.
        try { void audio.play().then(() => settle(), settle); }
        catch (error) { settle(error); }
      });
    },
    play(url, options = {}) {
      // This defensive stop also keeps the adapter exclusive when used alone.
      stop();
      const audio = elementFor(url);
      audio.pause();
      audio.currentTime = 0;
      audio.volume = options.volume ?? 0.8;
      audio.playbackRate = options.playbackRate ?? 1;
      audio.preservesPitch = false;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          if (watchdog !== undefined) clock.clearTimeout(watchdog);
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
        // Every shipped cue is short. A suspended/stalled element must not
        // retain the shared channel or finish a stale notice much later.
        const watchdog = clock.setTimeout(() => {
          try { audio.pause(); audio.currentTime = 0; }
          catch { /* timeout cleanup is best effort for detached media */ }
          settle(new Error("local audio playback timed out"));
        }, 5_000);
        try { void audio.play().catch(settle); }
        catch (error) { settle(error); }
      });
    },
    preload(urls) { for (const url of urls) elementFor(url); },
    setVolume(volume) { if (active !== null) active.element.volume = volume; },
    stop,
    dispose() {
      try { stop(); } finally {
        for (const element of elements.values()) {
          try {
            element.pause();
            element.removeAttribute("src");
            element.load();
          } catch { /* a failed element must not prevent clearing the others */ }
        }
        elements.clear();
      }
    },
  };
}

const browserClock: AudioClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as ReturnType<typeof window.setTimeout>),
};
