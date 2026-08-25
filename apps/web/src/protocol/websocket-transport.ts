import {
  ClientCommandSchema,
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type CommandResultPayload,
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
}

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
  private retryTimer: unknown | null = null;
  private retryAttempt = 0;

  constructor(private readonly options: WebSocketTransportOptions) {}

  connect(roomId: string, playerToken: string): void {
    this.cancelRetry();
    this.disconnect(this.roomId !== roomId, false);
    this.roomId = roomId;
    this.playerToken = playerToken;
    this.openConnection(roomId, playerToken);
  }

  private openConnection(roomId: string, playerToken: string): void {
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
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = (event) => this.handleClose(event.code);
    socket.onerror = () => this.transition("CLOSED");
  }

  disconnect(clearPending = true, preserveSession = false): void {
    this.cancelRetry();
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

  prepareCommand(command: Omit<Exclude<ClientCommand, Extract<ClientCommand, { type: "AUTHENTICATE" }>>, "requestId">): PendingCommand {
    const requestId = this.options.createUuid();
    const full = ClientCommandSchema.parse({ ...command, requestId }) as PendingCommand["command"];
    return { command: full, serialized: JSON.stringify(full), requestId, actionId: full.type === "SUBMIT_ACTION" ? full.payload.actionId : undefined, status: "SENDING" };
  }

  prepareSubmitAction(tournamentId: string, expectedSequence: string, action: SubmitAction): PendingCommand {
    return this.prepareCommand({ type: "SUBMIT_ACTION", payload: { tournamentId, expectedSequence, action, actionId: this.options.createUuid() } });
  }

  /** Retry sends the exact initial serialization, preserving requestId/actionId/payload. */
  send(command: PendingCommand): void {
    if (this.state !== "CONNECTED" && this.state !== "RESYNCING") throw new Error("WebSocket is not authenticated");
    this.socket?.send(command.serialized);
    this.pending.set(command.requestId, command);
  }

  private handleMessage(raw: string): void {
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
        this.acceptReconnect(message.payload as ReconnectResult);
        this.recycleAppliedPending();
        this.retryAttempt = 0;
        this.transition("CONNECTED");
        return;
      case "ROOM_SNAPSHOT":
        this.acceptRoom(message.payload as RoomSnapshot);
        return;
      case "GAME_SNAPSHOT":
        this.options.projectionStore.acceptGameSnapshot(message.payload as GameSnapshot);
        this.recycleAppliedPending();
        this.retryAttempt = 0;
        this.transition("CONNECTED");
        return;
      case "GAME_EVENT": {
        const result = this.options.projectionStore.acceptGameEvent(message as GameEventMessage);
        if (result === "APPLIED") this.recycleAppliedPending();
        if (result === "RESYNC") this.requestSnapshot(this.options.projectionStore.getSnapshot().resyncReason ?? "INVALID_EVENT");
        return;
      }
      case "RESYNC_REQUIRED":
        this.options.projectionStore.requestResync("MANUAL");
        this.transition("RESYNCING");
        this.requestSnapshot("MANUAL");
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
        return; // TEX-23 keeps the transport boundary; display clock wiring is a later UI concern.
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
    if (result.status === "REJECTED") {
      this.pending.delete(result.requestId);
      this.handleError(result.error?.code ?? "INVALID_MESSAGE");
    }
  }

  private acceptReconnect(result: ReconnectResult): void {
    this.options.projectionStore.acceptReconnectResult(result.roomSnapshot, result.gameSnapshot);
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

  private acceptRoom(snapshot: RoomSnapshot): void {
    this.options.projectionStore.acceptRoomSnapshot(snapshot);
    if (snapshot.status === "CLOSED" && this.roomId !== null) this.options.tokenStore.clear(this.roomId, "CLOSED");
  }

  private handleInvalidMessage(): void {
    this.options.onProtocolError?.("INVALID_MESSAGE");
    this.options.projectionStore.requestResync("INVALID_EVENT");
    if (!this.requestSnapshot("INVALID_EVENT")) this.closeForProtocolError();
  }

  private handleError(code: ErrorCode): void {
    this.options.onProtocolError?.(code);
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
  }

  private requestSnapshot(reason: ResyncReason): boolean {
    const game = this.options.projectionStore.getSnapshot().game;
    const lastSequence = this.options.projectionStore.getSnapshot().lastSequence;
    if (game === null || lastSequence === null || this.socket === null || this.state === "STOPPED") return false;
    const command = this.prepareCommand({ type: "REQUEST_SNAPSHOT", payload: { tournamentId: game.tournamentId, lastSequence, reason } });
    this.socket.send(command.serialized);
    return true;
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
    this.state = next;
    this.options.onConnectionState?.(next);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null || this.roomId === null || this.playerToken === null) return;
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)]!;
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
}

const browserClock: WebSocketClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
