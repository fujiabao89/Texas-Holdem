/**
 * 真实链路压测引擎原语（TEX-29）。
 *
 * 只走真实链路：HTTP（create/join/PATCH/start）+ WS（AUTH/SET_READY/SUBMIT_ACTION）
 * + 真实 game-server（含真实 projection/序列化/持久化 Writer）。字段与流程以
 * TEX-28 真实链路底座（tests/clients/ws-client.ts、tests/e2e/real/support/api.ts）
 * 与 packages/protocol schema 为准（见 README「协议锚点」）。
 *
 * 本模块不落盘任何敏感值：playerToken 只留在内存 session，永不进入产物。
 */
import { randomUUID } from "node:crypto";

import { PROTOCOL_VERSION } from "../../packages/protocol/src/index";
import { WsTestClient } from "../clients/ws-client";
import type { MetricsCollector } from "./metrics";

export interface GameConfig {
  readonly maxPlayers: number;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly blindMode: "fixed";
  readonly blindStructure: readonly { readonly smallBlind: number; readonly bigBlind: number }[];
  readonly actionTime: 15 | 20 | 30 | 45 | 60;
  readonly timeBank: 0 | 30 | 60 | 120;
}

/** 固定盲注 5/10、起始 1000、actionTime 15s 的可信默认桌配置（fixed 模式仅 1 级）。 */
export function defaultGameConfig(maxPlayers: number): GameConfig {
  return {
    maxPlayers,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 15,
    timeBank: 0,
  };
}

/** 服务端合法动作视图（common.ts LegalActionsSchema 字段）。 */
export interface LegalActionsView {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  readonly callAmount: number;
  readonly canBet: boolean;
  readonly minBetTo: number | null;
  readonly canRaise: boolean;
  readonly minRaiseTo: number | null;
  readonly maxRaiseTo: number;
  readonly canAllIn: boolean;
  readonly allInTo: number;
}

export type WireAction =
  | { readonly type: "FOLD" }
  | { readonly type: "CHECK" }
  | { readonly type: "CALL" }
  | { readonly type: "BET"; readonly betTo: number }
  | { readonly type: "RAISE"; readonly raiseTo: number }
  | { readonly type: "ALL_IN" };

/** 确定性小随机：同一 seed 恒同序列（仅用于动作多样性，不需加密）。 */
export function prng01(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** 保守且带少量进攻的合法动作选择（min 加注恒合法，避免 INVALID_AMOUNT）。 */
export function chooseAction(legal: LegalActionsView, rand: () => number): WireAction {
  if (legal.canCheck) return { type: "CHECK" };
  const r = rand();
  if (r < 0.15 && legal.canRaise && legal.minRaiseTo !== null) {
    return { type: "RAISE", raiseTo: legal.minRaiseTo };
  }
  if (legal.canCall) return { type: "CALL" };
  if (legal.canBet && legal.minBetTo !== null) return { type: "BET", betTo: legal.minBetTo };
  if (legal.canRaise && legal.minRaiseTo !== null) return { type: "RAISE", raiseTo: legal.minRaiseTo };
  if (legal.canAllIn) return { type: "ALL_IN" };
  if (legal.canFold) return { type: "FOLD" };
  throw new Error(`无法从合法动作中做出选择：${JSON.stringify(legal)}`);
}

/** REJECTED 错误码中的竞态类（策略正确前提下仍可能出现的重试型拒绝，不计为回归）。 */
const BENIGN_REJECTION = new Set(["STALE_GAME_STATE", "NOT_YOUR_TURN", "ACTION_TIMEOUT", "SESSION_REPLACED"]);

export function classifyRejected(errorCode: string | undefined, metrics: MetricsCollector): void {
  if (errorCode === undefined || !BENIGN_REJECTION.has(errorCode)) {
    metrics.inc("invariantViolations");
  }
}

export interface RoomSession {
  readonly roomId: string;
  readonly inviteCode: string;
  readonly config: GameConfig;
  readonly host: PlayerSession;
  readonly players: readonly PlayerSession[];
  tournamentId: string | null;
  /** 房级乐观锁 revision（每次 HTTP/ready 变更后刷新，开赛/终局/再来依赖它）。 */
  revision: string;
}

export interface PlayerSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly seat: number;
  readonly token: string;
  ws: WsTestClient | null;
}

export interface ServerInfo {
  readonly httpBase: string;
  readonly wsBase: string;
}

export function serverInfoFrom(serverBase: string): ServerInfo {
  const httpBase = serverBase.replace(/\/$/, "");
  return { httpBase, wsBase: httpBase.replace(/^http/, "ws") + "/api/v1/ws" };
}

interface Envelope {
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown; readonly traceId?: unknown };
}

export class PerfHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code} (HTTP ${status}): ${message}`);
    this.name = "PerfHttpError";
  }
}

/** HTTP 客户端：记录每次请求到 metrics（httpRequests/http5xx），信封解析与错误 code 透传。 */
export class PerfHttp {
  private readonly base: string;

  constructor(serverBase: string, private readonly metrics: MetricsCollector) {
    this.base = serverBase.replace(/\/$/, "");
  }

  private async request(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    options: { readonly token?: string } = {},
  ): Promise<Envelope> {
    this.metrics.inc("httpRequests");
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      body: JSON.stringify(body),
    });
    if (response.status >= 500) this.metrics.inc("http5xx");
    const envelope = (await response.json().catch(() => ({}))) as Envelope;
    if (envelope.error !== undefined) {
      const code = typeof envelope.error.code === "string" ? envelope.error.code : "UNKNOWN";
      throw new PerfHttpError(
        response.status,
        code,
        typeof envelope.error.message === "string" ? envelope.error.message : String(envelope.error.message),
        envelope.error,
      );
    }
    return envelope;
  }

  async createRoom(
    displayName: string,
    config: GameConfig,
  ): Promise<PlayerSession & { readonly inviteCode: string; readonly roomRevision: string }> {
    const envelope = await this.request("POST", "/api/v1/rooms", { displayName, config });
    const data = envelope.data as {
      roomId: string;
      playerId: string;
      playerToken: string;
      roomSnapshot: { inviteCode: string; roomRevision: string };
    };
    return {
      roomId: data.roomId,
      playerId: data.playerId,
      displayName,
      seat: 0,
      token: data.playerToken,
      ws: null,
      inviteCode: data.roomSnapshot.inviteCode,
      roomRevision: data.roomSnapshot.roomRevision,
    };
  }

  async joinRoom(
    inviteCode: string,
    displayName: string,
    seat: number,
  ): Promise<PlayerSession & { readonly roomRevision: string }> {
    const envelope = await this.request("POST", "/api/v1/rooms/join", { inviteCode, displayName });
    const data = envelope.data as {
      roomId: string;
      playerId: string;
      playerToken: string;
      roomSnapshot: { roomRevision: string };
    };
    return {
      roomId: data.roomId,
      playerId: data.playerId,
      displayName,
      seat,
      token: data.playerToken,
      ws: null,
      roomRevision: data.roomSnapshot.roomRevision,
    };
  }

  /** 返回变更后的 roomRevision。 */
  async changeSeat(
    roomId: string,
    token: string,
    expectedRevision: string,
    seat: number,
  ): Promise<string> {
    const envelope = await this.request(
      "PATCH",
      `/api/v1/rooms/${roomId}`,
      { expectedRoomRevision: expectedRevision, operation: { type: "CHANGE_SEAT", seat } },
      { token },
    );
    return (envelope.data as { roomSnapshot: { roomRevision: string } }).roomSnapshot.roomRevision;
  }

  async startTournament(
    roomId: string,
    hostToken: string,
    expectedRevision: string,
  ): Promise<{ readonly tournamentId: string; readonly roomRevision: string }> {
    const envelope = await this.request(
      "POST",
      `/api/v1/rooms/${roomId}/tournaments`,
      { expectedRoomRevision: expectedRevision },
      { token: hostToken },
    );
    const data = envelope.data as { tournamentId: string; roomSnapshot: { roomRevision: string } };
    return { tournamentId: data.tournamentId, roomRevision: data.roomSnapshot.roomRevision };
  }
}

export function authenticateCommand(roomId: string, token: string): unknown {
  return {
    type: "AUTHENTICATE",
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    payload: { roomId, playerToken: token },
  };
}

export function setReadyCommand(ready: boolean): unknown {
  return { type: "SET_READY", requestId: randomUUID(), payload: { ready } };
}

export function submitActionCommand(
  tournamentId: string,
  expectedSequence: string,
  action: WireAction,
): { readonly frame: unknown; readonly requestId: string } {
  const requestId = randomUUID();
  return {
    requestId,
    frame: {
      type: "SUBMIT_ACTION",
      requestId,
      payload: {
        tournamentId,
        actionId: randomUUID(),
        expectedSequence,
        action,
      },
    },
  };
}

/** 等待 client 里「从 fromIndex 起」满足谓词的新消息；超时返回 null。 */
export async function waitForIndexed(
  client: WsTestClient,
  predicate: (message: { readonly type: string; readonly payload?: unknown }) => boolean,
  fromIndex: number,
  label: string,
  timeoutMs: number,
): Promise<{ readonly type: string; readonly payload?: unknown } | null> {
  try {
    return await client.waitFor(
      (message) => client.messages.indexOf(message) >= fromIndex && predicate(message),
      timeoutMs,
      label,
    );
  } catch {
    return null;
  }
}

/** 关闭会话并等待 close 完成（同一玩家再次重连前先确认旧连接已释放）。 */
export async function closeSession(session: PlayerSession): Promise<void> {
  const ws = session.ws;
  if (ws === null) return;
  session.ws = null;
  ws.close();
  await ws.closed.catch(() => undefined);
}

export interface ReconnectOutcome {
  readonly ok: boolean;
  readonly latencyMs: number | null;
}

/**
 * 单次重连：open → AUTHENTICATE → 等待首个 RECONNECT_RESULT（含 room+game 快照）。
 * 认证到 RESULT 的耗时即「认证至首个完整 Snapshot」样本；失败计入 recoveryFailures。
 * recoveryAttempts 恒等于尝试数（成功或失败均 +1）。连接为局部：测量后立即关闭，
 * 不悬挂到 session（storm 的多次重连由 driver 按座串行调度）。
 */
export async function reconnectOnce(
  server: ServerInfo,
  session: Pick<PlayerSession, "roomId" | "token">,
  metrics: MetricsCollector,
): Promise<ReconnectOutcome> {
  metrics.inc("wsConnections");
  metrics.inc("recoveryAttempts");
  let ws: WsTestClient | null = null;
  try {
    ws = await WsTestClient.open(server.wsBase);
    const t0 = Date.now();
    const result = await ws.authenticate(session.roomId, session.token);
    const latencyMs = Date.now() - t0;
    if (result.type === "ERROR") {
      metrics.inc("recoveryFailures");
      return { ok: false, latencyMs: null };
    }
    metrics.pushReconnectLatency(latencyMs);
    return { ok: true, latencyMs };
  } catch {
    metrics.inc("recoveryFailures");
    return { ok: false, latencyMs: null };
  } finally {
    if (ws !== null) {
      ws.close();
      await ws.closed.catch(() => undefined);
    }
  }
}
