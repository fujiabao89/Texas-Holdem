import type { Card, GameEvent, GameEventMessage, GameSnapshot } from "@texas-holdem/protocol";

import { animationTimings, hardForwardBacklogMs, hardForwardEvents, softCatchUpBacklogMs, softCatchUpRate, softCatchUpTasks } from "./timings";

export type AnimationKind = "DEAL" | "BURN" | "BOARD" | "WAGER" | "FOLD" | "SHOWDOWN" | "POT_AWARD" | "ELIMINATION" | "FINISH";

export interface PresentationOverlay {
  readonly kind: AnimationKind;
  readonly event: GameEvent;
  /** BURN_CARD contains no face value, and presentation never manufactures one. */
  readonly burnCardBackOnly: boolean;
  /** Copied directly from the server-projected PLAYER_REVEALED payload. */
  readonly bestFiveCards: readonly Card[];
  /** Public board cards included in this already accepted server event. */
  readonly boardCards: readonly Card[];
  /** The existing board length before this event, used only to place the visual destination slots. */
  readonly boardStartIndex: number;
  /** The last second-round card needs an atomic flight-to-seat handoff. */
  readonly finalHoleCardDeal: boolean;
}

export interface PresentationState {
  readonly game: GameSnapshot | null;
  readonly overlay: PresentationOverlay | null;
  readonly mode: "NORMAL" | "SOFT_CATCH_UP" | "HARD_FORWARD";
  /**
   * Presentation-only progress for the opening two-round deal. Canonical
   * cards remain available to actions immediately, while seats reveal only
   * after the final projected deal event has visibly landed.
   */
  readonly holeDeal: HoleDealPresentation | null;
}

export interface HoleDealPresentation {
  readonly handId: string;
  readonly dealtCardCounts: Readonly<Record<string, number>>;
  /** Copied only from the server-projected viewer hole cards. */
  readonly viewerCardsForReveal: readonly Card[];
}

export interface AnimationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AnimationQueueOptions {
  readonly clock?: AnimationClock;
  readonly onHardForward?: () => void;
  readonly onEventStarted?: (event: GameEvent) => void;
}

type Listener = () => void;
interface QueueItem {
  readonly message: GameEventMessage;
  readonly beforePresentation: GameSnapshot | null;
  readonly afterCanonical: GameSnapshot;
  readonly durationMs: number;
  readonly finalHoleCardDeal: boolean;
}

const browserClock: AnimationClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Serializes visual work from already accepted server events. It has no
 * Transport or command dependency, so presentation can never delay a hand.
 */
export class AnimationQueue {
  private readonly clock: AnimationClock;
  private readonly listeners = new Set<Listener>();
  private readonly queue: QueueItem[] = [];
  private active: QueueItem | null = null;
  private timer: unknown | null = null;
  private tailTarget: GameSnapshot | null = null;
  private reducedMotion = false;
  private state: PresentationState = { game: null, overlay: null, mode: "NORMAL", holeDeal: null };
  private holeDealHandId: string | null = null;
  private holeDealActive = false;
  private readonly firstRoundRecipients = new Set<string>();
  private readonly secondRoundRecipients = new Set<string>();
  private readonly dealtCardCounts = new Map<string, number>();

  constructor(private readonly options: AnimationQueueOptions = {}) { this.clock = options.clock ?? browserClock; }

  getSnapshot = (): PresentationState => this.state;
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.commitAllFinalFrames();
  }

  /** Snapshot and reconnect are barriers: discard old work and never replay it. */
  alignToSnapshot(game: GameSnapshot | null): void {
    this.clearTimer();
    this.active = null;
    this.queue.splice(0);
    this.tailTarget = game;
    this.resetHoleDeal();
    this.replace({ game, overlay: null, mode: "NORMAL", holeDeal: null });
  }

  enqueue(message: GameEventMessage, afterCanonical: GameSnapshot): void {
    const finalHoleCardDeal = this.registerHoleDealEvent(message);
    const item: QueueItem = {
      message,
      beforePresentation: this.tailTarget ?? this.state.game,
      afterCanonical,
      durationMs: durationFor(message.payload.event, finalHoleCardDeal),
      finalHoleCardDeal,
    };
    this.tailTarget = afterCanonical;
    if (this.reducedMotion) {
      this.resetHoleDeal();
      this.replace({ game: afterCanonical, overlay: null, mode: "NORMAL", holeDeal: null });
      return;
    }
    if (message.payload.event.type === "DEAL_HOLE_CARD" && this.holeDealActive) {
      this.replace({ ...this.state, holeDeal: this.currentHoleDeal() });
    }
    this.queue.push(item);
    // An all-in can arrive as one burst. Compress it, but do not erase the
    // only public showdown/best-five explanation the player can inspect.
    if (this.shouldHardForward() && !this.hasShowdownSemanticFrame()) { this.hardForward(); return; }
    this.pump();
  }

  /** Cancellation is also a final-frame path, never a stale partial frame. */
  cancel(): void { this.commitAllFinalFrames(); }

  private pump(): void {
    if (this.active !== null) return;
    const item = this.queue.shift();
    if (item === undefined) { this.replace({ ...this.state, mode: "NORMAL" }); return; }
    this.active = item;
    const soft = this.shouldSoftCatchUp();
    const viewerCardsForReveal = item.finalHoleCardDeal ? item.afterCanonical.viewer.holeCards : [];
    const holeDeal = this.holeDealActive ? this.currentHoleDeal(viewerCardsForReveal) : null;
    this.replace({ game: item.beforePresentation, overlay: overlayFor(item.message.payload.event, item.beforePresentation, item.finalHoleCardDeal), mode: soft ? "SOFT_CATCH_UP" : "NORMAL", holeDeal });
    try { this.options.onEventStarted?.(item.message.payload.event); }
    catch { this.finishActive(); return; }
    // Soft Catch-up may condense ordinary acknowledgement feedback, but it
    // must not outrun a visible card sequence. Board and showdown frames keep
    // their declared pace so the final canonical commit cannot snap cards into
    // place before their CSS flight/flip has completed.
    const playbackRate = soft && !isPacedSemanticEvent(item.message.payload.event) ? softCatchUpRate : 1;
    this.timer = this.clock.setTimeout(() => this.finishActive(), Math.round(item.durationMs / playbackRate));
  }

  private finishActive(): void {
    this.timer = null;
    const item = this.active;
    this.active = null;
    if (item !== null) this.commitFinalFrame(item);
    this.pump();
  }

  private commitFinalFrame(item: QueueItem): void {
    if (item.message.payload.event.type === "DEAL_HOLE_CARD") {
      const playerId = item.message.payload.event.payload.playerId;
      this.dealtCardCounts.set(playerId, Math.min(2, (this.dealtCardCounts.get(playerId) ?? 0) + 1));
      if (item.finalHoleCardDeal) this.holeDealActive = false;
    }
    if (this.state.game?.sequence === item.afterCanonical.sequence && this.state.overlay === null && !item.finalHoleCardDeal) return;
    this.replace({ game: item.afterCanonical, overlay: null, mode: this.state.mode, holeDeal: this.holeDealActive ? this.currentHoleDeal() : null });
  }

  private commitAllFinalFrames(): void {
    this.clearTimer();
    if (this.active !== null) this.commitFinalFrame(this.active);
    for (const item of this.queue) this.commitFinalFrame(item);
    this.active = null;
    this.queue.splice(0);
    this.tailTarget = this.state.game;
    this.resetHoleDeal();
    this.replace({ ...this.state, overlay: null, mode: "NORMAL", holeDeal: null });
  }

  private hardForward(): void {
    const latest = this.tailTarget;
    this.clearTimer();
    this.active = null;
    this.queue.splice(0);
    this.resetHoleDeal();
    this.replace({ game: latest, overlay: null, mode: "HARD_FORWARD", holeDeal: null });
    this.options.onHardForward?.();
    this.replace({ game: latest, overlay: null, mode: "NORMAL", holeDeal: null });
  }

  private registerHoleDealEvent(message: GameEventMessage): boolean {
    const { event, handId } = message.payload;
    if (event.type === "HAND_STARTED") this.resetHoleDeal();
    if (event.type !== "DEAL_HOLE_CARD") return false;
    if (this.holeDealHandId !== handId) this.resetHoleDeal(handId);
    this.holeDealActive = true;
    if (event.payload.cardIndex === 0) this.firstRoundRecipients.add(event.payload.playerId);
    else this.secondRoundRecipients.add(event.payload.playerId);
    return event.payload.cardIndex === 1
      && this.firstRoundRecipients.size > 0
      && this.secondRoundRecipients.size === this.firstRoundRecipients.size;
  }

  private currentHoleDeal(viewerCardsForReveal: readonly Card[] = []): HoleDealPresentation | null {
    if (!this.holeDealActive || this.holeDealHandId === null) return null;
    return {
      handId: this.holeDealHandId,
      dealtCardCounts: Object.fromEntries(this.dealtCardCounts),
      viewerCardsForReveal,
    };
  }

  private resetHoleDeal(handId: string | null = null): void {
    this.holeDealHandId = handId;
    this.holeDealActive = false;
    this.firstRoundRecipients.clear();
    this.secondRoundRecipients.clear();
    this.dealtCardCounts.clear();
  }

  private clearTimer(): void { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  private shouldSoftCatchUp(): boolean { return this.estimatedBacklogMs() > softCatchUpBacklogMs || this.queue.length > softCatchUpTasks; }
  private shouldHardForward(): boolean { return this.estimatedBacklogMs() > hardForwardBacklogMs || this.queue.length > hardForwardEvents; }
  private hasShowdownSemanticFrame(): boolean {
    const isShowdown = (item: QueueItem): boolean => item.message.payload.event.type === "SHOWDOWN_STARTED" || item.message.payload.event.type === "PLAYER_REVEALED";
    return (this.active !== null && isShowdown(this.active)) || this.queue.some(isShowdown);
  }
  private estimatedBacklogMs(): number { return (this.active?.durationMs ?? 0) + this.queue.reduce((sum, item) => sum + item.durationMs, 0); }
  private replace(next: PresentationState): void { this.state = next; for (const listener of this.listeners) listener(); }
}

function durationFor(event: GameEvent, finalHoleCardDeal: boolean): number {
  switch (event.type) {
    case "DEAL_HOLE_CARD": return animationTimings.deal + (finalHoleCardDeal ? animationTimings.holeRevealPause + animationTimings.ownCardReveal + animationTimings.ownCardRevealStagger : 0);
    case "BURN_CARD": return animationTimings.burn;
    case "FLOP_DEALT": return animationTimings.flopCard * 3 + animationTimings.flopInterval * 2;
    case "TURN_DEALT": case "RIVER_DEALT": return animationTimings.turnRiver;
    case "BLIND_POSTED": case "PLAYER_CALLED": case "PLAYER_BET": case "PLAYER_RAISED": return animationTimings.wager;
    case "PLAYER_CHECKED": return animationTimings.check;
    case "PLAYER_FOLDED": return animationTimings.fold;
    case "PLAYER_ALL_IN": return animationTimings.allIn;
    case "SHOWDOWN_STARTED": return animationTimings.check;
    case "PLAYER_REVEALED": return animationTimings.showdownReveal + animationTimings.bestFive;
    case "POT_AWARDED": return animationTimings.winner + animationTimings.potAward;
    case "PLAYER_ELIMINATED": case "PLAYER_WITHDRAWN": return animationTimings.fold;
    case "TOURNAMENT_FINISHED": return animationTimings.handEnd;
    case "HAND_STARTED": case "UNCALLED_BET_RETURNED": return 0;
  }
}

/** These frames convey public information; Soft Catch-up never shortens them. */
function isPacedSemanticEvent(event: GameEvent): boolean {
  switch (event.type) {
    case "DEAL_HOLE_CARD":
    case "BURN_CARD":
    case "FLOP_DEALT":
    case "TURN_DEALT":
    case "RIVER_DEALT":
    case "SHOWDOWN_STARTED":
    case "PLAYER_REVEALED":
    case "POT_AWARDED":
    case "PLAYER_ELIMINATED":
    case "PLAYER_WITHDRAWN":
    case "TOURNAMENT_FINISHED":
      return true;
    default:
      return false;
  }
}

function overlayFor(event: GameEvent, beforePresentation: GameSnapshot | null, finalHoleCardDeal: boolean): PresentationOverlay {
  const kind: AnimationKind = event.type === "DEAL_HOLE_CARD" ? "DEAL" : event.type === "BURN_CARD" ? "BURN"
    : event.type === "FLOP_DEALT" || event.type === "TURN_DEALT" || event.type === "RIVER_DEALT" ? "BOARD"
      : event.type === "PLAYER_FOLDED" ? "FOLD" : event.type === "SHOWDOWN_STARTED" || event.type === "PLAYER_REVEALED" ? "SHOWDOWN"
        : event.type === "POT_AWARDED" ? "POT_AWARD" : event.type === "PLAYER_ELIMINATED" || event.type === "PLAYER_WITHDRAWN" ? "ELIMINATION"
          : event.type === "TOURNAMENT_FINISHED" ? "FINISH" : "WAGER";
  const boardCards = event.type === "FLOP_DEALT" ? event.payload.cards
    : event.type === "TURN_DEALT" || event.type === "RIVER_DEALT" ? [event.payload.card] : [];
  return {
    kind,
    event,
    burnCardBackOnly: event.type === "BURN_CARD",
    bestFiveCards: event.type === "PLAYER_REVEALED" ? event.payload.handRank.bestFiveCards : [],
    boardCards,
    boardStartIndex: beforePresentation?.board.length ?? 0,
    finalHoleCardDeal,
  };
}
