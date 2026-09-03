import {
  applyPlayerViewPatch,
  GameSnapshotSchema,
  type GameEvent,
  type GameEventMessage,
  type GameSnapshot,
  type ClockUpdatedPayload,
  type PlayerView,
  type RoomSnapshot,
} from "@texas-holdem/protocol";

export type ResyncReason = "GAP" | "INVALID_EVENT" | "STALE_ACTION" | "MANUAL";

/**
 * Read-only copy of an already-applied game event, kept for the hand-history
 * drawer's "current hand in progress" rendering. Raw payloads stay here; the
 * timeline presentation derives from them without touching canonical state.
 */
export interface AppliedHandEvent {
  readonly handId: string | null;
  readonly sequence: string;
  readonly event: GameEvent;
}

export interface ProjectionState {
  readonly room: RoomSnapshot | null;
  readonly game: GameSnapshot | null;
  readonly lastSequence: string | null;
  readonly actionsDisabled: boolean;
  readonly resyncReason: ResyncReason | null;
  /** Display-only clock data, never a source of game authority. */
  readonly clock: ClockProjection | null;
  /** Applied events of the hand currently buffered; any snapshot resets it. */
  readonly currentHandEvents: readonly AppliedHandEvent[];
}

export interface ClockProjection {
  readonly tournamentId: string;
  readonly handId: string | null;
  readonly currentActorPlayerId: string | null;
  readonly actionDeadline: number | null;
  readonly timeBankRemainingMs: number;
  readonly serverTime: number;
}

/** Presentation can observe only events which have passed projection checks. */
export interface AcceptedGameEvent {
  readonly message: GameEventMessage;
  readonly afterCanonical: GameSnapshot;
}

/** A fresh Snapshot invalidates every queued presentation task. */
export interface ProjectionBarrier {
  readonly game: GameSnapshot | null;
  readonly kind: "GAME_SNAPSHOT" | "RECONNECT_RESULT";
}

type Listener = () => void;

const initialState: ProjectionState = {
  room: null,
  game: null,
  lastSequence: null,
  actionsDisabled: false,
  resyncReason: null,
  clock: null,
  currentHandEvents: [],
};

/**
 * Client-side mirror of server projections. UI code gets a readonly snapshot and
 * cannot mutate it; only snapshot replacement and a verified event patch update it.
 */
export class ProjectionStore {
  private state: ProjectionState = initialState;
  private readonly listeners = new Set<Listener>();
  private readonly acceptedEventListeners = new Set<(event: AcceptedGameEvent) => void>();
  private readonly barrierListeners = new Set<(barrier: ProjectionBarrier) => void>();

  getSnapshot = (): ProjectionState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeAcceptedGameEvents(listener: (event: AcceptedGameEvent) => void): () => void {
    this.acceptedEventListeners.add(listener);
    return () => this.acceptedEventListeners.delete(listener);
  }

  subscribeBarriers(listener: (barrier: ProjectionBarrier) => void): () => void {
    this.barrierListeners.add(listener);
    return () => this.barrierListeners.delete(listener);
  }

  acceptRoomSnapshot(snapshot: RoomSnapshot): void {
    const current = this.state.room;
    if (current !== null && current.roomId === snapshot.roomId && compareUint64(snapshot.roomRevision, current.roomRevision) <= 0) return;
    this.replace({ ...this.state, room: snapshot });
  }

  /** A reconnect result is a fresh server-authoritative barrier for both projections. */
  acceptReconnectResult(room: RoomSnapshot, game: GameSnapshot | null, serverTime = 0): void {
    if (game !== null) GameSnapshotSchema.parse(game);
    // 服务端在锦标赛结束后清空 activeTournamentId，重连只会带回 gameSnapshot:null
    // （docs/02 §9.3）。终局快照不可变：同房间的 FINISHED 快照照单清空会让
    // 牌桌 → 结果页的页内导航（重连）丢失唯一的结果数据源，结果页永远落入
    // 「快照不可用」（TEX-28 F-3）。新一局开始时 GAME_SNAPSHOT 屏障会整体替换。
    const previousGame = this.state.room?.roomId === room.roomId ? this.state.game : null;
    const retained = game === null && previousGame?.tournamentStatus === "FINISHED" ? previousGame : game;
    this.replace({
      room,
      game: retained,
      lastSequence: retained?.sequence ?? null,
      actionsDisabled: false,
      resyncReason: null,
      clock: retained === null ? null : clockFromSnapshot(retained, serverTime),
      currentHandEvents: [],
    });
    this.emitBarrier({ game: retained, kind: "RECONNECT_RESULT" });
  }

  acceptGameSnapshot(snapshot: GameSnapshot, serverTime = 0): void {
    GameSnapshotSchema.parse(snapshot);
    this.replace({
      ...this.state,
      game: snapshot,
      lastSequence: snapshot.sequence,
      actionsDisabled: false,
      resyncReason: null,
      clock: clockFromSnapshot(snapshot, serverTime),
      currentHandEvents: [],
    });
    this.emitBarrier({ game: snapshot, kind: "GAME_SNAPSHOT" });
  }

  acceptGameEvent(message: GameEventMessage): "APPLIED" | "IGNORED" | "RESYNC" {
    const { game, lastSequence } = this.state;
    if (game === null || lastSequence === null) return this.requestResync("INVALID_EVENT");
    if (message.payload.tournamentId !== game.tournamentId) return this.requestResync("INVALID_EVENT");
    if (hasUnauthorizedPrivateCard(message, game)) return this.requestResync("INVALID_EVENT");

    const comparison = compareUint64(message.payload.sequence, lastSequence);
    if (comparison <= 0) return "IGNORED";
    if (comparison !== 1 || !isNextSequence(message.payload.sequence, lastSequence)) return this.requestResync("GAP");

    try {
      const afterView = applyPlayerViewPatch(asPlayerView(game), message.payload.patch);
      const next = GameSnapshotSchema.parse({
        ...afterView,
        snapshotVersion: 1,
        reason: game.reason,
        tournamentId: game.tournamentId,
        sequence: message.payload.sequence,
      });
      if (!matchesEventHand(message.payload.handId, game.handId, next.handId)) return this.requestResync("INVALID_EVENT");
      this.replace({ ...this.state, game: next, lastSequence: next.sequence, clock: clockFromSnapshot(next, message.serverTime), currentHandEvents: appendHandEvent(this.state.currentHandEvents, message) });
      this.emitAcceptedEvent({ message, afterCanonical: next });
      return "APPLIED";
    } catch {
      return this.requestResync("INVALID_EVENT");
    }
  }

  requestResync(reason: ResyncReason): "RESYNC" {
    this.replace({ ...this.state, actionsDisabled: true, resyncReason: reason });
    return "RESYNC";
  }

  /** CLOCK_UPDATED must match the current game action and never alters game data. */
  acceptClockUpdated(payload: ClockUpdatedPayload, serverTime: number): void {
    const game = this.state.game;
    const previous = this.state.clock;
    if (
      game === null ||
      payload.tournamentId !== game.tournamentId ||
      payload.handId !== game.handId ||
      payload.currentActorPlayerId !== game.currentActorPlayerId ||
      (previous !== null && serverTime < previous.serverTime)
    ) return;
    this.replace({ ...this.state, clock: { ...payload, serverTime } });
  }

  private replace(next: ProjectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private emitAcceptedEvent(event: AcceptedGameEvent): void {
    for (const listener of this.acceptedEventListeners) listener(event);
  }

  private emitBarrier(barrier: ProjectionBarrier): void {
    for (const listener of this.barrierListeners) listener(barrier);
  }
}

/** Event envelope identity must agree with the accepted patch's hand boundary. */
function matchesEventHand(eventHandId: string | null, previousHandId: string | null, nextHandId: string | null): boolean {
  return eventHandId === nextHandId || (nextHandId === null && eventHandId === previousHandId);
}

function clockFromSnapshot(snapshot: GameSnapshot, serverTime: number): ClockProjection {
  return {
    tournamentId: snapshot.tournamentId,
    handId: snapshot.handId,
    currentActorPlayerId: snapshot.currentActorPlayerId,
    actionDeadline: snapshot.actionDeadline,
    timeBankRemainingMs: snapshot.viewer.timeBankRemainingMs,
    serverTime,
  };
}

function asPlayerView(snapshot: GameSnapshot): PlayerView {
  const { snapshotVersion: _snapshotVersion, reason: _reason, tournamentId: _tournamentId, sequence: _sequence, ...view } = snapshot;
  return view;
}

/**
 * Buffers an applied event for the drawer's in-progress hand. Events of a new
 * handId start a fresh buffer, so a settled hand never leaks into the next one.
 */
function appendHandEvent(events: readonly AppliedHandEvent[], message: GameEventMessage): readonly AppliedHandEvent[] {
  const entry: AppliedHandEvent = { handId: message.payload.handId, sequence: message.payload.sequence, event: message.payload.event };
  const currentHandId = events.length > 0 ? events[0].handId : entry.handId;
  return currentHandId === entry.handId ? [...events, entry] : [entry];
}

function hasUnauthorizedPrivateCard(message: GameEventMessage, game: GameSnapshot): boolean {
  const event = message.payload.event;
  return event.type === "DEAL_HOLE_CARD" && event.payload.card !== undefined && event.payload.playerId !== game.viewer.playerId;
}

export function compareUint64(left: string, right: string): -1 | 0 | 1 {
  const difference = BigInt(left) - BigInt(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function isNextSequence(candidate: string, previous: string): boolean {
  return BigInt(candidate) === BigInt(previous) + 1n;
}
