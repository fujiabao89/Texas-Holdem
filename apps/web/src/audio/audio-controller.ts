import type { GameEvent } from "@texas-holdem/protocol";

export type SoundName = "deal" | "board" | "check" | "bet" | "fold" | "allIn" | "pot" | "turn" | "finish";

export interface AudioAdapter {
  unlock(): Promise<void>;
  play(url: string): Promise<void>;
  preload?(urls: readonly string[]): void;
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

  constructor(private readonly adapter: AudioAdapter) {}

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }

  async unlock(): Promise<void> {
    try { await this.adapter.unlock(); this.unlocked = true; }
    catch { /* autoplay policies are a silent visual-only fallback */ }
  }

  preloadCritical(): void {
    this.adapter.preload?.([soundUrls.turn, soundUrls.allIn, soundUrls.pot]);
  }

  playEvent(event: GameEvent): void {
    const sound = soundFor(event);
    if (!this.enabled || !this.unlocked || sound === null) return;
    void this.adapter.play(soundUrls[sound]).catch(() => undefined);
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
  return {
    async unlock() {
      // Creating and immediately pausing a local audio element is enough to
      // bind subsequent playback to the user's gesture without remote audio.
      const audio = new Audio(soundUrls.check);
      audio.muted = true;
      try { await audio.play(); } finally { audio.pause(); }
    },
    async play(url) { await new Audio(url).play(); },
    preload(urls) { for (const url of urls) { const audio = new Audio(); audio.preload = "auto"; audio.src = url; } },
  };
}
