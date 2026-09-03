/**
 * 可编程 WebSocket 测试客户端（TEX-28 Multiplayer/WS 层）。
 *
 * 通过真实 `ws` 连接接入被测服务的 `/api/v1/ws`；每条入站帧都以
 * `ServerMessageSchema` 严格校验（递归拒绝未知字段），原文保留供字段级
 * 安全扫描。故障注入（drop/duplicate/delay/reorder）由测试在发送侧以
 * `onSend` 故障脚本或调用顺序表达（docs/06 §6：每个用例记录故障脚本与 seed）。
 *
 * 等待条件只挂接在真实到达的消息上（可观察状态），不使用任意 sleep；
 * 等待超时默认 5 秒（真实墙钟，仅用于测试驱动，不进入被测断言）。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type CommandResultPayload,
  type GameEventMessage,
  type GameSnapshot,
  type ProtocolError,
  type ReconnectResult,
  type RoomSnapshot,
  type ServerMessage,
} from "../../packages/protocol/src/index";

export interface WsCloseEvent {
  readonly code: number | null;
  readonly reason: string;
}

export interface WsTestClientOptions {
  /** 故障脚本：发送前改写帧序列（返回 [] 表示丢弃，重复元素表示重复发送）。 */
  readonly onSend?: (frame: string) => string[];
}

interface Waiter {
  readonly predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  readonly label: string;
}

export class WsTestClient {
  private readonly socket: WebSocket;
  private readonly waiters = new Set<Waiter>();
  private closedResolve!: (event: WsCloseEvent) => void;
  readonly closed: Promise<WsCloseEvent>;
  readonly messages: ServerMessage[] = [];
  readonly rawFrames: string[] = [];
  readonly schemaViolations: { frame: string; issues: string }[] = [];
  closeEvent: WsCloseEvent | null = null;
  private readonly onSend?: (frame: string) => string[];

  private constructor(socket: WebSocket, options: WsTestClientOptions = {}) {
    this.socket = socket;
    this.onSend = options.onSend;
    this.closed = new Promise<WsCloseEvent>((resolve) => {
      this.closedResolve = resolve;
    });
    socket.on("message", (raw: WebSocket.RawData) => this.handleFrame(raw.toString()));
    socket.on("close", (code: number, reason: Buffer) => {
      this.closeEvent = { code, reason: reason.toString() };
      for (const waiter of this.waiters) {
        waiter.reject(new Error(`socket closed while waiting for ${waiter.label}`));
      }
      this.waiters.clear();
      this.closedResolve(this.closeEvent);
    });
    socket.on("error", () => undefined);
  }

  static open(wsUrl: string, options: WsTestClientOptions = {}): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.once("open", () => resolve(new WsTestClient(socket, options)));
      socket.once("error", (error: Error) => reject(error));
    });
  }

  private handleFrame(frame: string): void {
    this.rawFrames.push(frame);
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      this.schemaViolations.push({ frame, issues: "not valid JSON" });
      return;
    }
    const parsed = ServerMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.schemaViolations.push({ frame, issues: JSON.stringify(parsed.error.issues) });
      return;
    }
    this.messages.push(parsed.data);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(parsed.data)) {
        this.waiters.delete(waiter);
        waiter.resolve(parsed.data);
      }
    }
  }

  /** 发送一条命令（不做客户端校验，便于注入非法帧测试服务端拒绝路径）。 */
  send(command: unknown): void {
    const frame = JSON.stringify(command);
    const frames = this.onSend === undefined ? [frame] : this.onSend(frame);
    for (const item of frames) this.socket.send(item);
  }

  sendRaw(frame: string): void {
    this.socket.send(frame);
  }

  authenticate(roomId: string, playerToken: string, requestId = randomUUID()): Promise<ServerMessage> {
    // 只匹配发送之后新到达的帧：同一连接可能已收到过 ERROR（如 INVALID_MESSAGE），
    // 不能把历史错误误认作本次认证结果。
    const startIndex = this.messages.length;
    this.send({
      type: "AUTHENTICATE",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      payload: { roomId, playerToken },
    });
    return this.waitForNew(
      (message) => message.type === "RECONNECT_RESULT" || message.type === "ERROR",
      startIndex,
      5_000,
      "AUTHENTICATE result",
    );
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 5_000,
    label = "condition",
  ): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return this.waitForNew(predicate, this.messages.length, timeoutMs, label);
  }

  /** 只等待 startIndex 之后新到达的消息（区分历史帧与本次调用触发的帧）。 */
  private waitForNew(
    predicate: (message: ServerMessage) => boolean,
    startIndex: number,
    timeoutMs: number,
    label: string,
  ): Promise<ServerMessage> {
    const filtered = (message: ServerMessage) => this.messages.indexOf(message) >= startIndex && predicate(message);
    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate: filtered,
        label,
        resolve,
        reject,
      };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) {
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
        }
      }, timeoutMs);
    });
  }

  /** ServerMessage 的 type 判别在 z.infer 层被泛型 helper 拓宽为 string，需显式收窄。 */
  isCommandResult(message: ServerMessage): message is ServerMessage & { type: "COMMAND_RESULT"; payload: CommandResultPayload } {
    return message.type === "COMMAND_RESULT";
  }

  isReconnectResult(message: ServerMessage): message is ServerMessage & { type: "RECONNECT_RESULT"; payload: ReconnectResult } {
    return message.type === "RECONNECT_RESULT";
  }

  isRoomSnapshot(message: ServerMessage): message is ServerMessage & { type: "ROOM_SNAPSHOT"; payload: RoomSnapshot } {
    return message.type === "ROOM_SNAPSHOT";
  }

  isGameEvent(message: ServerMessage): message is ServerMessage & { type: "GAME_EVENT"; payload: GameEventMessage } {
    return message.type === "GAME_EVENT";
  }

  isGameSnapshot(message: ServerMessage): message is ServerMessage & { type: "GAME_SNAPSHOT"; payload: GameSnapshot } {
    return message.type === "GAME_SNAPSHOT";
  }

  isError(message: ServerMessage): message is ServerMessage & { type: "ERROR"; payload: ProtocolError } {
    return message.type === "ERROR";
  }

  waitForCommandResult(requestId: string, timeoutMs = 5_000): Promise<CommandResultPayload> {
    // 幂等重放测试要求区分「首次结果」与「重放结果」：只匹配调用之后新到达的帧。
    const startIndex = this.messages.length;
    return this.waitFor(
      (message) => {
        const index = this.messages.indexOf(message);
        return index >= startIndex && this.isCommandResult(message) && message.payload.requestId === requestId;
      },
      timeoutMs,
      `COMMAND_RESULT ${requestId}`,
    ).then((message) => {
      if (!this.isCommandResult(message)) throw new Error(`expected COMMAND_RESULT for ${requestId}`);
      return message.payload;
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, "test teardown");
    }
  }
}