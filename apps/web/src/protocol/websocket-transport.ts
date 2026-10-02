import {
  ClientCommandSchema,
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type CommandResultPayload,
  type ClockUpdatedPayload,
  type ClientCommand,
  type ErrorCode,
  type GameEventMessage,
  type GameSnapshot,
  type ProtocolError,
  type ReconnectResult,
  type RoomSnapshot,
  type SubmitAction,
  validateServerMessage,
} from "@texas-holdem/protocol";

import { ProjectionStore, type ResyncReason } from "../state/projection-store";
import { PlayerTokenStore } from "./token-store";

export type ConnectionState = "IDLE" | "CONNECTING" | "AUTHENTICATING" | "CONNECTED" | "RESYNCING" | "STOPPED" | "CLOSED";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PendingCommand {
  readonly command: Exclude<ClientCommand, Extract<ClientCommand, { type: "AUTHENTICATE" }>>;
  readonly serialized: string;
  readonly requestId: string;
  readonly actionId?: string;
  readonly appliedSequence?: string;
  readonly status: "SENDING" | "APPLIED_AWAITING_STATE" | "REJECTED";
  /** Local identity captured at preparation; never serialized onto the wire. */
  readonly opportunity?: { readonly handId: string | null; readonly playerId: string; readonly actorId: string | null };
}

export interface WebSocketTransportOptions {
  readonly wsUrl: string;
  readonly socketFactory: (url: string) => WebSocketLike;
  readonly createUuid: () => string;
  readonly projectionStore: ProjectionStore;
  readonly tokenStore: PlayerTokenStore;
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onCommandResult?: (pending: PendingCommand) => void;
  readonly onProtocolError?: (code: ErrorCode) => void;
  readonly clock?: WebSocketClock;
  /** Injectable so reconnect jitter remains deterministic in tests. */
  readonly random?: () => number;
  readonly monotonicNow?: () => number;
}

export type CommandResultListener = (pending: PendingCommand, result: CommandResultPayload) => void;
export type ProtocolErrorListener = (code: ErrorCode) => void;

export interface WebSocketClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class WebSocketTransport {
  private socket: WebSocketLike | null = null;
  private roomId: string | null = null;
  private playerToken: string | null = null;
  private state: ConnectionState = "IDLE";
  private readonly pending = new Map<string, PendingCommand>();
  private readonly commandResultListeners = new Set<CommandResultListener>();
  private readonly protocolErrorListeners = new Set<ProtocolErrorListener>();
  private retryTimer: unknown | null = null;
  private retryAttempt = 0;
  private syncTimer: unknown | null = null;
  private syncProbe: { readonly requestId: string; readonly clientSentAt: number } | null = null;

  constructor(private readonly options: WebSocketTransportOptions) {}

  connect(roomId: string, playerToken: string): void {
    this.cancelRetry();
    if (this.roomId !== roomId) this.options.projectionStore.resetTimeSync(false);
    this.disconnect(this.roomId !== roomId, false);
    this.roomId = roomId;
    this.playerToken = playerToken;
    this.openConnection(roomId, playerToken);
  }

  private openConnection(roomId: string, playerToken: string): void {
    this.stopTimeSync();
    this.options.projectionStore.resetTimeSync();
    this.transition("CONNECTING");
    const socket = this.options.socketFactory(this.options.wsUrl);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.transition("AUTHENTICATING");
      this.sendRaw({
        type: "AUTHENTICATE",
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.options.createUuid(),
        payload: { roomId, playerToken },
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.handleClose(event.code);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.transition("CLOSED");
    };
  }

  disconnect(clearPending = true, preserveSession = false): void {
    this.cancelRetry();
    this.stopTimeSync();
    const socket = this.socket;
    this.socket = null;
    if (clearPending) this.pending.clear();
    if (!preserveSession) this.playerToken = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    if (this.state !== "IDLE") this.transition("CLOSED");
  }

  /**
   * Presentation code can observe command acknowledgement without treating it
   * as a game-state update. The returned unsubscribe prevents route-lifetime
   * listeners from leaking across navigation.
   */
  subscribeCommandResults(listener: CommandResultListener): () => void {
    this.commandResultListeners.add(listener);
    return () => this.commandResultListeners.delete(listener);
  }

  /** Exposes stable transport errors for user feedback only. */
  subscribeProtocolErrors(listener: ProtocolErrorListener): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  prepareCommand(command: Omit<Exclude<ClientCommand, Extract<ClientCommand, { type: "AUTHENTICATE" }>>, "requestId">): PendingCommand {
    const requestId = this.options.createUuid();
    const full = ClientCommandSchema.parse({ ...command, requestId }) as PendingCommand["command"];
    const game = this.options.projectionStore.getSnapshot().game;
    const opportunity = (full.type === "SUBMIT_ACTION" || full.type === "USE_TIME_BANK") && game !== null
      ? { handId: game.handId, playerId: game.viewer.playerId, actorId: game.currentActorPlayerId } : undefined;
    return { command: full, serialized: JSON.stringify(full), requestId, actionId: full.type === "SUBMIT_ACTION" ? full.payload.actionId : undefined, status: "SENDING", opportunity };
  }

  prepareSubmitAction(tournamentId: string, expectedSequence: string, action: SubmitAction): PendingCommand {
    return this.prepareCommand({ type: "SUBMIT_ACTION", payload: { tournamentId, expectedSequence, action, actionId: this.options.createUuid() } });
  }

  /** Retry sends the exact initial serialization, preserving requestId/actionId/payload. */
  send(command: PendingCommand): void {
    if (this.state !== "CONNECTED" && this.state !== "RESYNCING") throw new Error("WebSocket is not authenticated");
    if (this.socket === null || this.socket.readyState !== 1) throw new Error("WebSocket is not open");
    if (command.command.type === "SUBMIT_ACTION" || command.command.type === "USE_TIME_BANK") {
      const game = this.options.projectionStore.getSnapshot().game;
      if (this.state !== "CONNECTED" || this.options.projectionStore.getSnapshot().actionsDisabled || !matchesActionOpportunity(command, game))
        throw new Error("Action opportunity is no longer available");
      for (const pending of this.pending.values()) {
        if (pending.requestId !== command.requestId && blocksTableSubmission(pending, game)) throw new Error("An action is already pending");
      }
    }
    this.pending.set(command.requestId, command);
    try { this.socket.send(command.serialized); }
    catch (error) { this.pending.delete(command.requestId); throw error; }
  }

  /** Presentation-only recovery request; it cannot send an Action command. */
  requestAuthoritativeSnapshot(reason: ResyncReason = "MANUAL"): boolean {
    this.options.projectionStore.requestResync(reason);
    const requested = this.requestSnapshot(reason);
    if (requested) this.transition("RESYNCING");
    return requested;
  }

  /** Browser online/visibility hints may advance an existing retry, never fork one. */
  reconnectNow(): void {
    if (this.state === "STOPPED" || this.roomId === null || this.playerToken === null) return;
    this.cancelRetry();
    if (this.state === "CLOSED") this.openConnection(this.roomId, this.playerToken);
    else if (this.state === "CONNECTED" && this.syncProbe === null) this.startTimeSync();
  }

  private handleMessage(raw: string): void {
    const receivedAt = this.options.monotonicNow?.() ?? performance.now();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.handleInvalidMessage();
      return;
    }
    const parsed = validateServerMessage(decoded);
    if (!parsed.success) {
      if (parsed.errorCode === "UNSUPPORTED_PROTOCOL_VERSION") this.handleError(parsed.errorCode);
      else this.handleInvalidMessage();
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "RECONNECT_RESULT":
        this.acceptReconnect(message.payload as ReconnectResult, message.serverTime);
        this.recycleAppliedPending();
        this.retryAttempt = 0;
        this.transition("CONNECTED");
        this.startTimeSync();
        this.retryUnresolvedPending();
        return;
      case "ROOM_SNAPSHOT":
        this.acceptRoom(message.payload as RoomSnapshot);
        return;
      case "GAME_SNAPSHOT":
        this.options.projectionStore.acceptGameSnapshot(message.payload as GameSnapshot, message.serverTime);
        this.recycleAppliedPending();
        this.retryAttempt = 0;
        this.transition("CONNECTED");
        if (this.syncProbe === null && this.syncTimer === null) this.startTimeSync();
        return;
      case "GAME_EVENT": {
        const result = this.options.projectionStore.acceptGameEvent(message as GameEventMessage);
        if (result === "APPLIED") this.recycleAppliedPending();
        if (result === "RESYNC") this.requestSnapshot(this.options.projectionStore.getSnapshot().resyncReason ?? "INVALID_EVENT");
        return;
      }
      case "RESYNC_REQUIRED":
        this.requestAuthoritativeSnapshot("MANUAL");
        return;
      case "COMMAND_RESULT":
        this.handleCommandResult(message.payload as CommandResultPayload);
        return;
      case "ERROR":
        this.handleError((message.payload as ProtocolError).code);
        return;
      case "SESSION_REPLACED":
        this.handleError("SESSION_REPLACED");
        return;
      case "CLOCK_UPDATED":
        this.options.projectionStore.acceptClockUpdated(message.payload as ClockUpdatedPayload, message.serverTime);
        return;
      case "TIME_SYNC_RESULT":
        if (this.syncProbe === null || message.payload.requestId !== this.syncProbe.requestId || message.payload.clientSentAt !== this.syncProbe.clientSentAt) return;
        if (!this.options.projectionStore.acceptTimeSync(message.payload, receivedAt)) return;
        this.stopTimeSync();
        this.syncTimer = (this.options.clock ?? browserClock).setTimeout(() => { this.syncTimer = null; this.startTimeSync(); }, 5_000);
        return;
    }
  }

  private handleCommandResult(result: CommandResultPayload): void {
    const pending = this.pending.get(result.requestId);
    if (pending === undefined) return;
    const next: PendingCommand = {
      ...pending,
      status: result.status === "APPLIED" ? "APPLIED_AWAITING_STATE" : "REJECTED",
      appliedSequence: result.appliedSequence,
    };
    this.pending.set(result.requestId, next);
    this.options.onCommandResult?.(next);
    for (const listener of this.commandResultListeners) listener(next, result);
    if (result.status === "REJECTED") {
      this.pending.delete(result.requestId);
      this.handleError(result.error?.code ?? "INVALID_MESSAGE");
      return;
    }
    if (pending.command.type === "LEAVE_ROOM" && this.roomId !== null) this.options.tokenStore.clear(this.roomId, "LEAVE_SUCCEEDED");
    this.recycleAppliedPending();
  }

  private acceptReconnect(result: ReconnectResult, serverTime: number): void {
    this.options.projectionStore.acceptReconnectResult(result.roomSnapshot, result.gameSnapshot, serverTime);
  }

  /** COMMAND_RESULT is feedback only; the matching authoritative sequence releases memory. */
  private recycleAppliedPending(): void {
    const sequence = this.options.projectionStore.getSnapshot().lastSequence;
    if (sequence === null) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.status === "APPLIED_AWAITING_STATE" && pending.appliedSequence !== undefined && BigInt(pending.appliedSequence) <= BigInt(sequence)) {
        this.pending.delete(requestId);
      }
    }
  }

  /** Unknown command delivery is retried byte-for-byte after the new snapshot barrier. */
  private retryUnresolvedPending(): void {
    const game = this.options.projectionStore.getSnapshot().game;
    for (const [requestId, pending] of this.pending) {
      if ((pending.command.type === "SUBMIT_ACTION" || pending.command.type === "USE_TIME_BANK") && !matchesActionOpportunity(pending, game)) {
        this.pending.delete(requestId);
        continue;
      }
      if (pending.status === "SENDING") this.socket?.send(pending.serialized);
    }
  }

  private acceptRoom(snapshot: RoomSnapshot): void {
    this.options.projectionStore.acceptRoomSnapshot(snapshot);
    if (snapshot.status === "CLOSED" && this.roomId !== null) {
      this.options.tokenStore.clear(this.roomId, "CLOSED");
      this.cancelRetry();
      this.transition("STOPPED");
    }
  }

  private handleInvalidMessage(): void {
    this.options.onProtocolError?.("INVALID_MESSAGE");
    for (const listener of this.protocolErrorListeners) listener("INVALID_MESSAGE");
    this.options.projectionStore.requestResync("INVALID_EVENT");
    if (!this.requestSnapshot("INVALID_EVENT")) this.closeForProtocolError();
  }

  private handleError(code: ErrorCode): void {
    this.options.onProtocolError?.(code);
    for (const listener of this.protocolErrorListeners) listener(code);
    if ((code === "AUTH_FAILED" || code === "INVITE_EXPIRED") && this.roomId !== null) this.options.tokenStore.clear(this.roomId, code);
    if (code === "AUTH_FAILED" || code === "UNSUPPORTED_PROTOCOL_VERSION" || code === "SESSION_REPLACED") {
      this.cancelRetry();
      this.transition("STOPPED");
      this.socket?.close(CLOSE_CODES.PROTOCOL_ERROR);
      return;
    }
    if (code === "STALE_GAME_STATE") {
      this.options.projectionStore.requestResync("STALE_ACTION");
      this.requestSnapshot("STALE_ACTION");
    }
    if (code === "ACTION_TIMEOUT") this.requestAuthoritativeSnapshot("STALE_ACTION");
  }

  private requestSnapshot(reason: ResyncReason): boolean {
    const game = this.options.projectionStore.getSnapshot().game;
    const lastSequence = this.options.projectionStore.getSnapshot().lastSequence;
    if (
      game === null ||
      lastSequence === null ||
      this.socket === null ||
      this.socket.readyState !== 1 ||
      (this.state !== "CONNECTED" && this.state !== "RESYNCING")
    ) return false;
    const command = this.prepareCommand({ type: "REQUEST_SNAPSHOT", payload: { tournamentId: game.tournamentId, lastSequence, reason } });
    try {
      this.socket.send(command.serialized);
      return true;
    } catch {
      return false;
    }
  }

  private closeForProtocolError(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(CLOSE_CODES.PROTOCOL_ERROR);
    }
    this.transition("CLOSED");
  }

  private handleClose(code: number): void {
    if (code === CLOSE_CODES.SESSION_REPLACED) this.handleError("SESSION_REPLACED");
    else if (code === CLOSE_CODES.AUTH_FAILED) this.handleError("AUTH_FAILED");
    else if (this.state !== "STOPPED") {
      this.transition("CLOSED");
      this.scheduleReconnect();
    }
  }

  private sendRaw(command: ClientCommand): void {
    this.socket?.send(JSON.stringify(ClientCommandSchema.parse(command)));
  }

  private transition(next: ConnectionState): void {
    if (next === "STOPPED" || next === "CLOSED") this.stopTimeSync();
    this.state = next;
    this.options.onConnectionState?.(next);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null || this.roomId === null || this.playerToken === null) return;
    const delays = [0, 500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;
    const baseDelay = delays[Math.min(this.retryAttempt, delays.length - 1)]!;
    const jitter = 0.8 + (this.options.random?.() ?? secureRandom()) * 0.4;
    const delay = Math.round(baseDelay * jitter);
    this.retryAttempt += 1;
    this.retryTimer = (this.options.clock ?? browserClock).setTimeout(() => {
      this.retryTimer = null;
      if (this.roomId !== null && this.playerToken !== null && this.state !== "STOPPED") this.openConnection(this.roomId, this.playerToken);
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) (this.options.clock ?? browserClock).clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
  }

  private startTimeSync(): void {
    if (this.state !== "CONNECTED" || this.socket?.readyState !== 1 || this.syncProbe !== null) return;
    this.stopTimeSync();
    const probe = { requestId: this.options.createUuid(), clientSentAt: this.options.monotonicNow?.() ?? performance.now() };
    this.syncProbe = probe;
    this.syncTimer = (this.options.clock ?? browserClock).setTimeout(() => {
      this.syncTimer = null;
      this.disconnect(false, true);
      this.scheduleReconnect();
    }, 10_000);
    try { this.socket.send(JSON.stringify(ClientCommandSchema.parse({ type: "TIME_SYNC", requestId: probe.requestId, payload: { clientSentAt: probe.clientSentAt } }))); }
    catch { this.disconnect(false, true); this.scheduleReconnect(); }
  }

  private stopTimeSync(): void {
    if (this.syncTimer !== null) (this.options.clock ?? browserClock).clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.syncProbe = null;
  }
}

export function matchesActionOpportunity(pending: PendingCommand, game: GameSnapshot | null): boolean {
  const command = pending.command;
  if (command.type !== "SUBMIT_ACTION" && command.type !== "USE_TIME_BANK") return false;
  return game !== null && game.tournamentStatus === "RUNNING"
    && command.payload.tournamentId === game.tournamentId && command.payload.expectedSequence === game.sequence
    && game.viewer.playerId === game.currentActorPlayerId && game.viewer.legalActions !== null
    && pending.opportunity?.handId === game.handId && pending.opportunity.playerId === game.viewer.playerId
    && pending.opportunity.actorId === game.currentActorPlayerId;
}

export function blocksTableSubmission(pending: PendingCommand | null, game: GameSnapshot | null): boolean {
  if (pending === null || game === null || pending.status === "REJECTED") return false;
  if (pending.status === "SENDING") return matchesActionOpportunity(pending, game);
  const command = pending.command;
  return (command.type === "SUBMIT_ACTION" || command.type === "USE_TIME_BANK")
    && command.payload.tournamentId === game.tournamentId
    && (pending.appliedSequence === undefined || BigInt(game.sequence) < BigInt(pending.appliedSequence));
}

const browserClock: WebSocketClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function secureRandom(): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0]! / 0x1_0000_0000;
}
