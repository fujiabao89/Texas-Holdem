import {
  applyPlayerViewPatch,
  GameSnapshotSchema,
  type GameEventMessage,
  type GameSnapshot,
  type PlayerView,
  type RoomSnapshot,
} from "@texas-holdem/protocol";

export type ResyncReason = "GAP" | "INVALID_EVENT" | "STALE_ACTION" | "MANUAL";

export interface ProjectionState {
  readonly room: RoomSnapshot | null;
  readonly game: GameSnapshot | null;
  readonly lastSequence: string | null;
  readonly actionsDisabled: boolean;
  readonly resyncReason: ResyncReason | null;
}

type Listener = () => void;

const initialState: ProjectionState = {
  room: null,
  game: null,
  lastSequence: null,
  actionsDisabled: false,
  resyncReason: null,
};

/**
 * Client-side mirror of server projections. UI code gets a readonly snapshot and
 * cannot mutate it; only snapshot replacement and a verified event patch update it.
 */
export class ProjectionStore {
  private state: ProjectionState = initialState;
  private readonly listeners = new Set<Listener>();

  getSnapshot = (): ProjectionState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  acceptRoomSnapshot(snapshot: RoomSnapshot): void {
    const current = this.state.room;
    if (current !== null && compareUint64(snapshot.roomRevision, current.roomRevision) <= 0) return;
    this.replace({ ...this.state, room: snapshot });
  }

  acceptGameSnapshot(snapshot: GameSnapshot): void {
    GameSnapshotSchema.parse(snapshot);
    this.replace({
      ...this.state,
      game: snapshot,
      lastSequence: snapshot.sequence,
      actionsDisabled: false,
      resyncReason: null,
    });
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
      this.replace({ ...this.state, game: next, lastSequence: next.sequence });
      return "APPLIED";
    } catch {
      return this.requestResync("INVALID_EVENT");
    }
  }

  requestResync(reason: ResyncReason): "RESYNC" {
    this.replace({ ...this.state, actionsDisabled: true, resyncReason: reason });
    return "RESYNC";
  }

  private replace(next: ProjectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function asPlayerView(snapshot: GameSnapshot): PlayerView {
  const { snapshotVersion: _snapshotVersion, reason: _reason, tournamentId: _tournamentId, sequence: _sequence, ...view } = snapshot;
  return view;
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
