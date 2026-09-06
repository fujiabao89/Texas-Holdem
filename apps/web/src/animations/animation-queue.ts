import type { Card, GameEvent, GameEventMessage, GameSnapshot } from "@texas-holdem/protocol";

import { animationTimings, hardForwardBacklogMs, hardForwardEvents, softCatchUpBacklogMs, softCatchUpRate, softCatchUpTasks } from "./timings";

export type AnimationKind = "DEAL" | "BURN" | "BOARD" | "WAGER" | "FOLD" | "SHOWDOWN" | "POT_AWARD" | "ELIMINATION" | "FINISH";

export interface PresentationOverlay {
  readonly eventKey: string;
  readonly durationMs: number;
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
  readonly outcomeEvents: readonly OutcomeEvent[];
  readonly notice: "SYNCED" | null;
  readonly reducedMotion: boolean;
  readonly game: GameSnapshot | null;
  readonly overlay: PresentationOverlay | null;
  readonly mode: "NORMAL" | "SOFT_CATCH_UP" | "HARD_FORWARD";
  /**
   * Presentation-only progress for the opening two-round deal. Canonical
   * cards remain available to actions immediately, while seats reveal only
   * after the final projected deal event has visibly landed.
   */
  readonly holeDeal: HoleDealPresentation | null;
  /** Opponent cards become visible only after their own public reveal frame commits. */
  readonly revealedPlayerIds: readonly string[];
}

export type OutcomeEvent = Extract<GameEvent, { type: "PLAYER_REVEALED" | "POT_AWARDED" }>;

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
  readonly onEventStarted?: (event: GameEvent, options?: { readonly immediate: boolean }) => void;
  readonly onPresentationReset?: () => void;
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
  private callbacks: Pick<AnimationQueueOptions, "onEventStarted" | "onPresentationReset">;
  private readonly clock: AnimationClock;
  private readonly listeners = new Set<Listener>();
  private readonly queue: QueueItem[] = [];
  private active: QueueItem | null = null;
  private timer: unknown | null = null;
  private tailTarget: GameSnapshot | null = null;
  private reducedMotion = false;
  private foreground = true;
  private activeDeadline = 0;
  private transitionTimer: unknown | null = null;
  private noticeTimer: unknown | null = null;
  private plannedHandId: string | null = null;
  private forwardOutcomeEvents: readonly OutcomeEvent[] = [];
  private state: PresentationState = { game: null, overlay: null, mode: "NORMAL", holeDeal: null, revealedPlayerIds: [], outcomeEvents: [], notice: null, reducedMotion: false };
  private holeDealHandId: string | null = null;
  private holeDealActive = false;
  private readonly firstRoundRecipients = new Set<string>();
  private readonly secondRoundRecipients = new Set<string>();
  private readonly dealtCardCounts = new Map<string, number>();

  constructor(private readonly options: AnimationQueueOptions = {}) { this.clock = options.clock ?? browserClock; this.callbacks = options; }

  setCallbacks(callbacks: Pick<AnimationQueueOptions, "onEventStarted" | "onPresentationReset">): void { this.callbacks = callbacks; }

  getSnapshot = (): PresentationState => this.state;
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  setReducedMotion(reducedMotion: boolean): void {
    if (this.reducedMotion === reducedMotion) return;
    this.reducedMotion = reducedMotion;
    if (reducedMotion && this.state.mode !== "HARD_FORWARD") {
      this.notifyPresentationReset();
      this.clearTransitions();
      this.commitAllFinalFrames();
    }
    this.replace({ ...this.state, reducedMotion, notice: null });
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) this.cancel();
  }

  /** Snapshot and reconnect are barriers: discard old work and never replay it. */
  alignToSnapshot(game: GameSnapshot | null): void {
    const synced = this.state.notice === "SYNCED";
    this.notifyPresentationReset();
    this.clearTimer();
    this.clearTransitions();
    this.active = null;
    this.queue.splice(0);
    this.tailTarget = game;
    this.resetHoleDeal();
    this.resetDealPlan();
    this.replace({ game, overlay: null, mode: "NORMAL", holeDeal: null, revealedPlayerIds: revealedPlayerIdsFor(game), outcomeEvents: [], notice: synced ? "SYNCED" : null, reducedMotion: this.reducedMotion });
    if (synced) this.expireNotice();
  }

  enqueue(message: GameEventMessage, afterCanonical: GameSnapshot): void {
    // ProjectionStore already validates continuity; this is defensive playback
    // deduplication, including after a local fast-forward.
    if (this.tailTarget?.tournamentId === afterCanonical.tournamentId && BigInt(message.payload.sequence) <= BigInt(this.tailTarget.sequence)) return;
    const finalHoleCardDeal = this.registerHoleDealEvent(message);
    const item: QueueItem = {
      message,
      beforePresentation: this.tailTarget ?? this.state.game,
      afterCanonical,
      durationMs: durationFor(message.payload.event, finalHoleCardDeal),
      finalHoleCardDeal,
    };
    this.tailTarget = afterCanonical;
    if (this.state.mode === "HARD_FORWARD") {
      // Freeze the public recap during its reading window, while retaining
      // only the latest canonical target and per-player/per-pot records.
      this.forwardOutcomeEvents = nextOutcomeEvents(this.forwardOutcomeEvents, message.payload.event, item.beforePresentation?.handId !== afterCanonical.handId);
      return;
    }
    if (this.reducedMotion || !this.foreground) {
      this.commitFinalFrame(item);
      this.resetHoleDeal();
      this.replace({ ...this.state, game: afterCanonical, overlay: null, holeDeal: null, revealedPlayerIds: revealedPlayerIdsFor(afterCanonical) });
      if (this.reducedMotion && this.foreground) this.notifyEventStarted(message.payload.event, true);
      return;
    }
    this.queue.push(item);
    // An all-in can arrive as one burst. Compress it, but do not erase the
    // only public showdown/best-five explanation the player can inspect.
    if (this.queue.length > hardForwardEvents * 2 || (this.shouldHardForward() && !this.hasShowdownSemanticFrame())) { this.hardForward(); return; }
    this.pump();
  }

  /** Cancellation is also a final-frame path, never a stale partial frame. */
  cancel(): void { this.notifyPresentationReset(); this.clearTransitions(); this.commitAllFinalFrames(); this.resetDealPlan(); this.replace({ ...this.state, notice: null }); }

  private pump(): void {
    if (this.active !== null || this.state.mode === "HARD_FORWARD") return;
    const item = this.queue.shift();
    if (item === undefined) { this.replace({ ...this.state, mode: "NORMAL" }); return; }
    this.active = item;
    this.activeDeadline = this.clock.now() + item.durationMs;
    if (item.message.payload.event.type === "HAND_STARTED" || this.holeDealHandId !== item.message.payload.handId) this.resetHoleDeal(item.message.payload.handId);
    if (item.message.payload.event.type === "DEAL_HOLE_CARD") this.holeDealActive = true;
    const soft = this.shouldSoftCatchUp();
    const viewerCardsForReveal = item.finalHoleCardDeal ? item.afterCanonical.viewer.holeCards : [];
    const holeDeal = this.holeDealActive ? this.currentHoleDeal(viewerCardsForReveal) : null;
    // Soft Catch-up may condense ordinary acknowledgement feedback, but it
    // must not outrun a visible card sequence. Board and showdown frames keep
    // their declared pace so the final canonical commit cannot snap cards into
    // place before their CSS flight/flip has completed.
    const playbackRate = soft && !isPacedSemanticEvent(item.message.payload.event) ? softCatchUpRate : 1;
    const durationMs = Math.round(item.durationMs / playbackRate);
    this.activeDeadline = this.clock.now() + durationMs;
    this.replace({ ...this.state, game: item.beforePresentation, overlay: overlayFor(item, durationMs), mode: soft ? "SOFT_CATCH_UP" : "NORMAL", holeDeal });
    this.notifyEventStarted(item.message.payload.event, false);
    this.timer = this.clock.setTimeout(() => this.finishActive(), durationMs);
  }

  private finishActive(): void {
    this.timer = null;
    const item = this.active;
    this.active = null;
    if (item !== null) this.commitFinalFrame(item);
    if (item !== null && this.shouldHardForward() && shouldHardForwardAfter(item.message.payload.event, this.queue)) {
      this.hardForward();
      return;
    }
    this.pump();
  }

  private commitFinalFrame(item: QueueItem): void {
    if (item.message.payload.event.type === "DEAL_HOLE_CARD") {
      const playerId = item.message.payload.event.payload.playerId;
      this.dealtCardCounts.set(playerId, Math.min(2, (this.dealtCardCounts.get(playerId) ?? 0) + 1));
      if (item.finalHoleCardDeal) this.holeDealActive = false;
    }
    if (this.state.game?.sequence === item.afterCanonical.sequence && this.state.overlay === null && !item.finalHoleCardDeal) return;
    this.replace({
      ...this.state,
      game: item.afterCanonical,
      overlay: null,
      mode: this.state.mode,
      holeDeal: this.holeDealActive ? this.currentHoleDeal() : null,
      revealedPlayerIds: nextRevealedPlayerIds(this.state.revealedPlayerIds, item.message.payload.event),
      outcomeEvents: nextOutcomeEvents(this.state.outcomeEvents, item.message.payload.event, this.state.game?.handId !== item.afterCanonical.handId),
    });
  }

  private commitAllFinalFrames(): void {
    this.clearTimer();
    // Flush once, without rendering every skipped frame or replaying its cue.
    let game = this.state.mode === "HARD_FORWARD" ? this.tailTarget : this.state.game;
    let outcomeEvents = this.state.mode === "HARD_FORWARD" ? this.forwardOutcomeEvents : this.state.outcomeEvents;
    for (const item of [...(this.active === null ? [] : [this.active]), ...this.queue]) {
      outcomeEvents = nextOutcomeEvents(outcomeEvents, item.message.payload.event, game?.handId !== item.afterCanonical.handId);
      game = item.afterCanonical;
    }
    this.active = null;
    this.queue.splice(0);
    this.tailTarget = game;
    this.resetHoleDeal();
    this.replace({ ...this.state, game, outcomeEvents, revealedPlayerIds: revealedPlayerIdsFor(game), overlay: null, mode: "NORMAL", holeDeal: null });
  }

  private hardForward(): void {
    this.notifyPresentationReset();
    this.clearTransitions();
    this.commitAllFinalFrames();
    this.forwardOutcomeEvents = this.state.outcomeEvents;
    const requestAfterHold = this.state.outcomeEvents.length > 0;
    const holdMs = requestAfterHold ? animationTimings.handEnd : animationTimings.hardForwardFade;
    this.replace({ ...this.state, mode: "HARD_FORWARD", notice: "SYNCED" });
    const request = () => { try { this.options.onHardForward?.(); } catch { /* latest canonical is still displayed */ } };
    // Hold an actual public result before a Snapshot barrier clears the recap.
    if (!requestAfterHold) request();
    this.transitionTimer = this.clock.setTimeout(() => {
      this.transitionTimer = null;
      this.replace({ ...this.state, game: this.tailTarget, outcomeEvents: this.forwardOutcomeEvents, revealedPlayerIds: revealedPlayerIdsFor(this.tailTarget), mode: "NORMAL", notice: "SYNCED" });
      if (requestAfterHold) request();
      this.expireNotice();
      this.pump();
    }, holdMs);
  }

  private registerHoleDealEvent(message: GameEventMessage): boolean {
    const { event, handId } = message.payload;
    if (event.type === "HAND_STARTED" || this.plannedHandId !== handId) this.resetDealPlan(handId);
    if (event.type !== "DEAL_HOLE_CARD") return false;
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
    this.dealtCardCounts.clear();
  }

  private resetDealPlan(handId: string | null = null): void {
    this.plannedHandId = handId;
    this.firstRoundRecipients.clear();
    this.secondRoundRecipients.clear();
  }

  private clearTransitions(): void {
    if (this.transitionTimer !== null) this.clock.clearTimeout(this.transitionTimer);
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
    this.transitionTimer = null;
    this.noticeTimer = null;
  }

  private expireNotice(): void {
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
    this.noticeTimer = this.clock.setTimeout(() => { this.noticeTimer = null; this.replace({ ...this.state, notice: null }); }, 3_000);
  }

  private notifyEventStarted(event: GameEvent, immediate: boolean): void {
    try { this.callbacks.onEventStarted?.(event, { immediate }); }
    catch { /* optional audio cannot skip a visible card or outcome */ }
  }

  private clearTimer(): void { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  private notifyPresentationReset(): void {
    try { this.callbacks.onPresentationReset?.(); }
    catch { /* presentation cleanup must never block the canonical final frame */ }
  }
  private shouldSoftCatchUp(): boolean { return this.estimatedBacklogMs() > softCatchUpBacklogMs || this.queue.length > softCatchUpTasks; }
  private shouldHardForward(): boolean { return this.estimatedBacklogMs() > hardForwardBacklogMs || this.queue.length + (this.active === null ? 0 : 1) > hardForwardEvents; }
  private hasShowdownSemanticFrame(): boolean {
    const isShowdown = (item: QueueItem): boolean => item.message.payload.event.type === "SHOWDOWN_STARTED" || item.message.payload.event.type === "PLAYER_REVEALED";
    return (this.active !== null && isShowdown(this.active)) || this.queue.some(isShowdown);
  }
  private estimatedBacklogMs(): number { return (this.active === null ? 0 : Math.max(0, this.activeDeadline - this.clock.now())) + this.queue.reduce((sum, item) => sum + item.durationMs, 0); }
  private replace(next: PresentationState): void { this.state = next; for (const listener of this.listeners) listener(); }
}

function nextOutcomeEvents(previous: readonly OutcomeEvent[], event: GameEvent, changedHand: boolean): readonly OutcomeEvent[] {
  const current = changedHand || event.type === "HAND_STARTED" ? [] : previous;
  if (event.type !== "PLAYER_REVEALED" && event.type !== "POT_AWARDED") return current;
  // One latest record per publicly revealed player / independently awarded pot.
  return [...current.filter((prior) => !(prior.type === "PLAYER_REVEALED" && event.type === "PLAYER_REVEALED" && prior.payload.playerId === event.payload.playerId) && !(prior.type === "POT_AWARDED" && event.type === "POT_AWARDED" && prior.payload.potIndex === event.payload.potIndex)), event];
}

function revealedPlayerIdsFor(game: GameSnapshot | null): readonly string[] {
  return game?.players.filter((player) => player.revealedCards.length > 0).map((player) => player.playerId) ?? [];
}

function nextRevealedPlayerIds(previous: readonly string[], event: GameEvent): readonly string[] {
  if (event.type === "HAND_STARTED") return [];
  if (event.type !== "PLAYER_REVEALED") return previous;
  return previous.includes(event.payload.playerId) ? previous : [...previous, event.payload.playerId];
}

function shouldHardForwardAfter(event: GameEvent, queued: readonly QueueItem[]): boolean {
  if (event.type === "PLAYER_REVEALED") return true;
  return event.type === "SHOWDOWN_STARTED" && !queued.some((item) => item.message.payload.event.type === "PLAYER_REVEALED");
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
    case "UNCALLED_BET_RETURNED": return animationTimings.wager;
    case "HAND_STARTED": return 0;
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

function overlayFor(item: QueueItem, durationMs: number): PresentationOverlay {
  const { message, beforePresentation, finalHoleCardDeal } = item;
  const event = message.payload.event;
  const kind: AnimationKind = event.type === "DEAL_HOLE_CARD" ? "DEAL" : event.type === "BURN_CARD" ? "BURN"
    : event.type === "FLOP_DEALT" || event.type === "TURN_DEALT" || event.type === "RIVER_DEALT" ? "BOARD"
      : event.type === "PLAYER_FOLDED" ? "FOLD" : event.type === "SHOWDOWN_STARTED" || event.type === "PLAYER_REVEALED" ? "SHOWDOWN"
        : event.type === "POT_AWARDED" ? "POT_AWARD" : event.type === "PLAYER_ELIMINATED" || event.type === "PLAYER_WITHDRAWN" ? "ELIMINATION"
          : event.type === "TOURNAMENT_FINISHED" ? "FINISH" : "WAGER";
  const boardCards = event.type === "FLOP_DEALT" ? event.payload.cards
    : event.type === "TURN_DEALT" || event.type === "RIVER_DEALT" ? [event.payload.card] : [];
  return {
    eventKey: `${message.payload.tournamentId}:${message.payload.handId}:${message.payload.sequence}`,
    durationMs,
    kind,
    event,
    burnCardBackOnly: event.type === "BURN_CARD",
    bestFiveCards: event.type === "PLAYER_REVEALED" ? event.payload.handRank.bestFiveCards : [],
    boardCards,
    boardStartIndex: beforePresentation?.board.length ?? 0,
    finalHoleCardDeal,
  };
}
