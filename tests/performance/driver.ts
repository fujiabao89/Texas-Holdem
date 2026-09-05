/**
 * 压测驱动（TEX-29）。
 *
 * 在 engine 原语之上组织场景执行：
 * - 持续类（smoke/normal/soak/headroom/burst 缩减）＝开桌 → 全员代理持续打牌，
 *   任一场锦标赛终局由 Host 对 FINISHED 房间「再来一局」续压，直到运行窗口结束；
 * - 重连风暴（reconnect）＝开桌开赛 → 对全部在座会话反复 AUTH→快照。
 *
 * 不变量在链路内断言：schema 违反（WsTestClient.schemaViolations）、事件 sequence
 * 非单调、COMMAND_RESULT 非竞态拒绝（服务端回归）→ invariantViolations/sequenceViolations。
 */
import { randomUUID } from "node:crypto";

import { WsTestClient } from "../clients/ws-client";
import type { MetricsCollector } from "./metrics";
import { soakRatioOrNull } from "./stats";
import * as E from "./engine";
import type { PlayerSession, RoomSession, ServerInfo, WireAction } from "./engine";

export interface RunWindow {
  /** 硬截止（epoch ms）：到达即停止新增动作并开始收尾。 */
  readonly deadlineMs: number;
  /** 是否已要求收尾（超时/异常）。 */
  stop: boolean;
}

export interface StartOneTableOptions {
  readonly http: E.PerfHttp;
  readonly server: ServerInfo;
  readonly metrics: MetricsCollector;
  /** 桌号（用于昵称/seed 唯一化）。 */
  readonly roomTag: string;
  readonly players: number;
}

interface AnyMessage {
  readonly type: string;
  readonly payload?: {
    readonly status?: string;
    readonly event?: { readonly type?: string };
    readonly sequence?: string;
    readonly tournamentId?: string;
    readonly patch?: {
      readonly currentActorPlayerId?: string | null;
      readonly tournamentStatus?: string;
      readonly viewer?: {
        readonly playerId?: string;
        readonly legalActions?: E.LegalActionsView | null;
      };
    };
    readonly roomRevision?: string;
  };
}

/**
 * 运行末尾扫描单连接收到的 GAME_EVENT：按 tournamentId 分组检查 sequence 严格 +1。
 * 任何非严格递增的落点都计为断点（真实链路 sequence/投影断言，见 docs/06 §10.1 burst）。
 */
export function countSequenceViolations(
  client: { readonly messages: readonly { readonly type: string; readonly payload?: unknown }[] },
  metrics: MetricsCollector,
): number {
  const lastSeq = new Map<string, number>();
  let found = 0;
  for (const raw of client.messages) {
    const message = raw as unknown as AnyMessage;
    if (message.type !== "GAME_EVENT") continue;
    const tournamentId = message.payload?.tournamentId;
    const sequence = message.payload?.sequence;
    if (typeof tournamentId !== "string" || typeof sequence !== "string") continue;
    const seq = Number(sequence);
    const previous = lastSeq.get(tournamentId);
    if (previous !== undefined && seq !== previous + 1) found += 1;
    lastSeq.set(tournamentId, seq);
  }
  if (found > 0) metrics.inc("sequenceViolations", found);
  return found;
}

/**
 * 统计单连接收到的 schema 违反（WsTestClient 对每帧做 ServerMessageSchema 严格校验，
 * 违反即丢弃并记录）并计入 invariantViolations：投影/序列化回归会使帧无法通过 schema。
 */
export function countSchemaViolations(
  session: { readonly ws: { readonly schemaViolations: readonly unknown[] } | null },
  metrics: MetricsCollector,
): number {
  const count = session.ws?.schemaViolations.length ?? 0;
  if (count > 0) metrics.inc("invariantViolations", count);
  return count;
}

function isActorTurn(message: AnyMessage, playerId: string): boolean {
  if (message.type !== "GAME_EVENT") return false;
  const patch = message.payload?.patch;
  return (
    patch?.currentActorPlayerId === playerId &&
    patch.viewer?.legalActions !== null &&
    patch.viewer?.legalActions !== undefined
  );
}

function isFinishedMarker(message: AnyMessage): boolean {
  if (message.type === "ROOM_SNAPSHOT") return message.payload?.status === "FINISHED";
  if (message.type === "GAME_EVENT") {
    return (
      message.payload?.event?.type === "TOURNAMENT_FINISHED" ||
      message.payload?.patch?.tournamentStatus === "FINISHED"
    );
  }
  return false;
}

async function connectAndAuthenticate(
  server: ServerInfo,
  session: PlayerSession,
  metrics: MetricsCollector,
): Promise<WsTestClient> {
  metrics.inc("wsConnections");
  const ws = await WsTestClient.open(server.wsBase);
  session.ws = ws;
  const result = await ws.authenticate(session.roomId, session.token);
  if (result.type === "ERROR") {
    throw new Error(`[driver] AUTH ERROR ${JSON.stringify(result.payload)}`);
  }
  return ws;
}

async function sendReady(ws: WsTestClient): Promise<void> {
  const requestId = randomUUID();
  // SetReadyCommandSchema（protocol）无 protocolVersion 字段（strict），多传会被拒绝。
  ws.send({ type: "SET_READY", requestId, payload: { ready: true } });
  const result = await ws.waitForCommandResult(requestId, 20_000);
  if (result.status !== "APPLIED") {
    throw new Error(`[driver] SET_READY REJECTED ${JSON.stringify(result.error)}`);
  }
}

/** 等 Host 看到全员入座且 Ready 的 LOBBY 快照，返回其 roomRevision。 */
async function allReadyRevision(hostWs: WsTestClient, total: number): Promise<string> {
  // 全员就绪快照可能已在等待前到达（host 的 SET_READY COMMAND_RESULT 常晚于广播），
  // 因此从头扫描既有缓冲；初始建房阶段只可能有一个“全部就绪”快照，不会误匹配。
  const fromIndex = 0;
  const message = await E.waitForIndexed(
    hostWs,
    (raw) => {
      const m = raw as AnyMessage;
      if (m.type !== "ROOM_SNAPSHOT") return false;
      const payload = m.payload as {
        status: string;
        players: { seat: number | null; ready: boolean }[];
      };
      return (
        payload.status === "LOBBY" &&
        payload.players.length === total &&
        payload.players.every((player) => player.seat !== null && player.ready)
      );
    },
    fromIndex,
    "全员入座且 Ready",
    30_000,
  );
  if (message === null) {
    throw new Error("[driver] 等待全员 Ready 超时：Host 未收到全员入座/Ready 的 LOBBY 快照");
  }
  const revision = (message as AnyMessage).payload?.roomRevision;
  if (typeof revision !== "string") throw new Error("[driver] Ready 快照缺 roomRevision");
  return revision;
}

/**
 * 建一桌并开赛：create（Host）→ join → 逐座 PATCH → 全员 WS AUTH → SET_READY →
 * Host 等到全员 Ready 快照 → POST tournaments。返回含 revision 与已连接会话的 RoomSession。
 */
export async function startOneTable(options: StartOneTableOptions): Promise<RoomSession> {
  const { http, server, metrics, roomTag, players } = options;
  const config = E.defaultGameConfig(players);

  const hostRaw = await http.createRoom(`h-${roomTag}`, config);
  const sessions: PlayerSession[] = [];
  const room: RoomSession = {
    roomId: hostRaw.roomId,
    inviteCode: hostRaw.inviteCode,
    config,
    host: {
      roomId: hostRaw.roomId,
      playerId: hostRaw.playerId,
      displayName: hostRaw.displayName,
      seat: 0,
      token: hostRaw.token,
      ws: null,
    },
    players: sessions,
    tournamentId: null,
    revision: hostRaw.roomRevision,
  };

  // 1) 其余玩家 join（先不入座，避免 seat 冲突与并发 PATCH 乐观锁）。
  let revision = room.revision;
  const seatPlan = [...Array.from({ length: players - 1 }, (_, i) => i + 1)];
  for (const seat of seatPlan) {
    const joined = await http.joinRoom(room.inviteCode, `p-${roomTag}-${seat}`, seat);
    sessions.push({
      roomId: joined.roomId,
      playerId: joined.playerId,
      displayName: joined.displayName,
      seat,
      token: joined.token,
      ws: null,
    });
    revision = joined.roomRevision;
  }

  // 2) Host + 各玩家依次 CHANGE_SEAT（每步刷新 revision）。
  for (const member of [room.host, ...sessions]) {
    revision = await http.changeSeat(room.roomId, member.token, revision, member.seat);
  }
  room.revision = revision;

  // 3) 全员开 WS 并认证。
  await connectAndAuthenticate(server, room.host, metrics);
  for (const session of sessions) {
    await connectAndAuthenticate(server, session, metrics);
  }

  // 4) 全员 SET_READY。
  await sendReady(room.host.ws!);
  for (const session of sessions) await sendReady(session.ws!);

  // 5) Host 等全员 Ready 快照并开赛。
  const readyRevision = await allReadyRevision(room.host.ws!, players);
  const started = await http.startTournament(room.roomId, room.host.token, readyRevision);
  room.tournamentId = started.tournamentId;
  room.revision = started.roomRevision;
  return room;
}

function latestFinishedRevision(hostWs: WsTestClient): string | null {
  for (let i = hostWs.messages.length - 1; i >= 0; i--) {
    const message = hostWs.messages[i] as unknown as AnyMessage;
    if (message.type === "ROOM_SNAPSHOT" && message.payload?.status === "FINISHED") {
      const revision = message.payload.roomRevision;
      if (typeof revision === "string") return revision;
    }
  }
  return null;
}

interface SharedTournament {
  finished: boolean;
}

/** 每座代理：在轮到且服务端给出合法动作时立刻行动并采样 Action→Event 延迟。 */
async function playerAgent(
  room: RoomSession,
  session: PlayerSession,
  metrics: MetricsCollector,
  window: RunWindow,
  shared: SharedTournament,
): Promise<void> {
  const ws = session.ws;
  if (ws === null) return;
  let cursor = ws.messages.length;
  const rand = E.prng01(0x9e3779b9 ^ ((session.seat + 1) * 2654435761));
  while (!shared.finished && Date.now() < window.deadlineMs && !window.stop) {
    const message = await E.waitForIndexed(
      ws,
      (raw) => {
        const m = raw as AnyMessage;
        return isActorTurn(m, session.playerId) || isFinishedMarker(m);
      },
      cursor,
      `seat${session.seat} 行动`,
      60_000,
    );
    if (message === null) {
      // 长时间无本人回合且未结束：继续等（可能整桌节奏慢）。
      continue;
    }
    cursor = ws.messages.length;
    const m = message as AnyMessage;
    if (isFinishedMarker(m)) {
      shared.finished = true;
      break;
    }
    const sequence = m.payload?.sequence;
    const patch = m.payload?.patch;
    const legal = patch?.viewer?.legalActions ?? null;
    if (
      legal === null ||
      patch?.currentActorPlayerId !== session.playerId ||
      room.tournamentId === null
    ) {
      continue;
    }
    const action: WireAction = E.chooseAction(legal, rand);
    const { frame, requestId } = E.submitActionCommand(room.tournamentId, sequence!, action);
    const t0 = Date.now();
    ws.send(frame);
    const result = await ws.waitForCommandResult(requestId, 30_000).catch(() => null);
    if (result !== null) {
      if (result.status === "APPLIED") {
        metrics.pushActionLatency(Date.now() - t0);
      } else {
        E.classifyRejected(result.error?.code, metrics);
      }
    }
    cursor = ws.messages.length;
  }
}

/** 打完当前这场锦标赛：全员代理并发行动，直到 TOURNAMENT_FINISHED / 窗口截止。 */
async function driveTournament(
  room: RoomSession,
  metrics: MetricsCollector,
  window: RunWindow,
): Promise<boolean> {
  const shared: SharedTournament = { finished: false };
  const agents = [room.host, ...room.players].map((session) =>
    playerAgent(room, session, metrics, window, shared),
  );
  // 轮询结束：不依赖某一代理收尾，避免淘汰座阻塞。
  while (!shared.finished && Date.now() < window.deadlineMs && !window.stop) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  window.stop = Date.now() >= window.deadlineMs;
  await Promise.all(agents).catch(() => undefined);
  return shared.finished;
}

/** 单桌持续压：打完一场自动「再来一局」，直到窗口截止。 */
async function driveRoom(
  room: RoomSession,
  http: E.PerfHttp,
  metrics: MetricsCollector,
  window: RunWindow,
): Promise<void> {
  while (Date.now() < window.deadlineMs && !window.stop) {
    const finished = await driveTournament(room, metrics, window);
    if (!finished || Date.now() >= window.deadlineMs) break;
    // 终局 rematch：Host 用最新 FINISHED 快照 revision 再来一局。
    const hostWs = room.host.ws;
    if (hostWs === null) break;
    const finishedRevision = latestFinishedRevision(hostWs) ?? room.revision;
    try {
      const started = await http.startTournament(room.roomId, room.host.token, finishedRevision);
      room.tournamentId = started.tournamentId;
      room.revision = started.roomRevision;
    } catch {
      // 终局与再来之间的瞬时并发（如他人已发起）→ 放弃本桌，避免无限重试。
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export interface SustainOutcome {
  readonly roomsStarted: number;
}

const MEMORY_SAMPLE_MS = 10_000;
const MEMORY_WINDOW_MS = 60 * 60_000; // Soak 对比窗口：1 小时

async function fetchServerGauge(server: ServerInfo, name: string): Promise<number | null> {
  try {
    const response = await fetch(`${server.httpBase}/metrics`);
    if (!response.ok) return null;
    return E.parsePrometheusGauge(await response.text(), name);
  } catch {
    return null;
  }
}

/**
 * 把 Soak 内存采样点换算为末/首窗口增长比并写入 collector（>1.1 会在门禁失败）；
 * 样本/时长不足时返回 null 且不改写（collector 保持 not-measured）。
 */
export function applySoakMemory(
  metrics: MetricsCollector,
  points: readonly { readonly tMs: number; readonly value: number }[],
  startMs: number,
  durationMs: number,
  windowMs: number,
): number | null {
  const ratio = soakRatioOrNull(points, startMs, durationMs, windowMs);
  if (ratio !== null) metrics.setMemoryGrowthRatio(ratio);
  return ratio;
}

/** 正式 Soak 是否具备可判样本（memoryGrowthRatio 非空）；否则应返回 EXIT.insufficient。 */
export function soakCanPass(metrics: MetricsCollector): boolean {
  return metrics.snapshot().memoryGrowthRatio !== null;
}

/** 持续场景（smoke/normal/soak/headroom/burst 缩减）：开 N 桌并打到窗口截止。 */
export async function runSustained(options: {
  readonly http: E.PerfHttp;
  readonly server: ServerInfo;
  readonly metrics: MetricsCollector;
  readonly rooms: number;
  readonly players: number;
  readonly durationMs: number;
  /** Soak：是否周期采样被测 /metrics RSS 以计算内存增长比。 */
  readonly sampleMemory?: boolean;
}): Promise<SustainOutcome> {
  const { http, server, metrics, rooms, players, durationMs, sampleMemory } = options;
  const tables: RoomSession[] = [];
  for (let i = 0; i < rooms; i++) {
    tables.push(await startOneTable({ http, server, metrics, roomTag: String(i), players }));
  }
  // 压测窗口从建桌完成（ramp-up 结束）起算，避免把串行建桌计入负载时长。
  const startMs = Date.now();
  const window: RunWindow = { deadlineMs: startMs + durationMs, stop: false };
  const memoryPoints: { readonly tMs: number; readonly value: number }[] = [];
  let memTimer: NodeJS.Timeout | null = null;
  if (sampleMemory === true) {
    const tick = (): void => {
      void fetchServerGauge(server, "texas_process_resident_memory_bytes").then((value) => {
        if (value !== null) memoryPoints.push({ tMs: Date.now(), value });
      });
    };
    tick();
    memTimer = setInterval(tick, MEMORY_SAMPLE_MS);
  }
  await Promise.all(tables.map((room) => driveRoom(room, http, metrics, window)));
  if (memTimer !== null) clearInterval(memTimer);
  if (sampleMemory === true) {
    // 末小时 vs 首个稳态小时（docs/06 §10.1）。时长 <2h 或样本不足 → 不改写（not-measured）。
    applySoakMemory(metrics, memoryPoints, startMs, durationMs, MEMORY_WINDOW_MS);
  }
  for (const table of tables) {
    for (const session of [table.host, ...table.players]) {
      if (session.ws !== null) {
        countSequenceViolations(session.ws, metrics);
        countSchemaViolations(session, metrics);
      }
      await E.closeSession(session);
    }
  }
  return { roomsStarted: tables.length };
}

export interface ReconnectStormOptions {
  /** 窗口毫秒：超过窗口即停止调度（缺省不限）。 */
  readonly windowMs?: number;
  readonly clock?: () => number;
  /** 可注入单次重连实现（测试用假实现，免真实网络）。 */
  readonly perform?: (
    server: ServerInfo,
    session: { readonly roomId: string; readonly token: string },
    metrics: MetricsCollector,
  ) => Promise<E.ReconnectOutcome>;
}

/**
 * 重连风暴：对全部在座会话反复「open→AUTH→首个快照」，attempts 分发给各座。
 * 只有 **在 opWindowMs 窗口内完成** 的重连才计入 completed；开始于窗口内但在截止后
 * 完成的操作不计入并停止调度。返回窗口内完成数（<attempts 即窗口内未完成 SLO）。
 */
export async function runReconnectStorm(
  rooms: readonly RoomSession[],
  server: ServerInfo,
  metrics: MetricsCollector,
  attempts: number,
  options: ReconnectStormOptions = {},
): Promise<number> {
  const { windowMs, clock = Date.now, perform = E.reconnectOnce } = options;
  const deadline = windowMs !== undefined ? clock() + windowMs : Number.POSITIVE_INFINITY;
  const seats = rooms.flatMap((room) => [room.host, ...room.players]);
  if (seats.length === 0) throw new Error("reconnect 场景没有在座会话");
  const perSeat = Math.max(1, Math.ceil(attempts / seats.length));
  let started = 0;
  let completed = 0;
  await mapWithConcurrency(
    seats,
    async (seat) => {
      for (let i = 0; i < perSeat && started < attempts && clock() < deadline; i++) {
        started += 1;
        await perform(server, { roomId: seat.roomId, token: seat.token }, metrics);
        // 以完成时刻为准：跨截止线的操作不计入窗口内完成数。
        if (clock() <= deadline) {
          completed += 1;
        } else {
          break;
        }
      }
    },
    40,
  );
  return completed;
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}
