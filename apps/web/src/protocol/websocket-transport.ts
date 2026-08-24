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
}

export class WebSocketTransport {
  private socket: WebSocketLike | null = null;
  private roomId: string | null = null;
  private state: ConnectionState = "IDLE";
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly options: WebSocketTransportOptions) {}

  connect(roomId: string, playerToken: string): void {
    this.disconnect();
    this.roomId = roomId;
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

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
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
        this.transition("CONNECTED");
        return;
      case "ROOM_SNAPSHOT":
        this.acceptRoom(message.payload as RoomSnapshot);
        return;
      case "GAME_SNAPSHOT":
        this.options.projectionStore.acceptGameSnapshot(message.payload as GameSnapshot);
        this.transition("CONNECTED");
        return;
      case "GAME_EVENT": {
        const result = this.options.projectionStore.acceptGameEvent(message as GameEventMessage);
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
    };
    this.pending.set(result.requestId, next);
    this.options.onCommandResult?.(next);
    if (result.status === "REJECTED") {
      this.pending.delete(result.requestId);
      this.handleError(result.error?.code ?? "INVALID_MESSAGE");
    }
  }

  private acceptReconnect(result: ReconnectResult): void {
    this.options.projectionStore.acceptRoomSnapshot(result.roomSnapshot);
    if (result.gameSnapshot !== null) this.options.projectionStore.acceptGameSnapshot(result.gameSnapshot);
  }

  private acceptRoom(snapshot: RoomSnapshot): void {
    this.options.projectionStore.acceptRoomSnapshot(snapshot);
    if (snapshot.status === "CLOSED" && this.roomId !== null) this.options.tokenStore.clear(this.roomId, "CLOSED");
  }

  private handleInvalidMessage(): void {
    this.options.onProtocolError?.("INVALID_MESSAGE");
    this.options.projectionStore.requestResync("INVALID_EVENT");
    this.requestSnapshot("INVALID_EVENT");
  }

  private handleError(code: ErrorCode): void {
    this.options.onProtocolError?.(code);
    if ((code === "AUTH_FAILED" || code === "INVITE_EXPIRED") && this.roomId !== null) this.options.tokenStore.clear(this.roomId, code);
    if (code === "AUTH_FAILED" || code === "UNSUPPORTED_PROTOCOL_VERSION" || code === "SESSION_REPLACED") {
      this.transition("STOPPED");
      this.socket?.close(CLOSE_CODES.PROTOCOL_ERROR);
      return;
    }
    if (code === "STALE_GAME_STATE") {
      this.options.projectionStore.requestResync("STALE_ACTION");
      this.requestSnapshot("STALE_ACTION");
    }
  }

  private requestSnapshot(reason: ResyncReason): void {
    const game = this.options.projectionStore.getSnapshot().game;
    const lastSequence = this.options.projectionStore.getSnapshot().lastSequence;
    if (game === null || lastSequence === null || this.socket === null || this.state === "STOPPED") return;
    const command = this.prepareCommand({ type: "REQUEST_SNAPSHOT", payload: { tournamentId: game.tournamentId, lastSequence, reason } });
    this.socket.send(command.serialized);
  }

  private handleClose(code: number): void {
    if (code === CLOSE_CODES.SESSION_REPLACED) this.handleError("SESSION_REPLACED");
    else if (code === CLOSE_CODES.AUTH_FAILED) this.handleError("AUTH_FAILED");
    else if (this.state !== "STOPPED") this.transition("CLOSED");
  }

  private sendRaw(command: ClientCommand): void {
    this.socket?.send(JSON.stringify(ClientCommandSchema.parse(command)));
  }

  private transition(next: ConnectionState): void {
    this.state = next;
    this.options.onConnectionState?.(next);
  }
}
