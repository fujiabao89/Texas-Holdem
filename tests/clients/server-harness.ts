/**
 * 进程内全链路 server harness（TEX-28 Multiplayer/WS 层）。
 *
 * 以生产装配方式（apps/game-server/src/main.ts 的同一接线）在测试进程内构建
 * 真实的 RoomManager / TournamentManager / TournamentEventBus / LobbyGateway /
 * HTTP 路由，仅以内存 RoomRepository Fake 替代 PostgreSQL 持久化。协议与运行时
 * 行为（认证、心跳、接管、幂等、序列、投影隐私）全部走真实代码路径；持久化
 * 事务结论由 Integration 层的真实 PostgreSQL 测试负责（docs/06 §3.2/§2.1）。
 *
 * 时间完全由 FakeClock 驱动（禁止真实等待）；洗牌由 SeededRandomSource 按
 * 场景 seed 派生，失败可 100% 重放（docs/06 §6）。
 */
import { SeededRandomSource } from "../../packages/poker-engine/src/index";
import type { TournamentConfig, RoomSnapshot } from "../../packages/protocol/src/index";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../apps/game-server/src/app";
import { createConnectionEpochRegistry } from "../../apps/game-server/src/realtime/connection-epochs";
import { createTournamentEventBus } from "../../apps/game-server/src/realtime/tournament-event-bus";
import { createNodeIdSource } from "../../apps/game-server/src/rooms/id-source";
import { createRoomManager, type RoomManager } from "../../apps/game-server/src/rooms/room-manager";
import { createRoomPersistence } from "../../apps/game-server/src/rooms/room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentRegistrar,
} from "../../apps/game-server/src/rooms/tournament-starter";
import type { TournamentManager } from "../../apps/game-server/src/tournaments/tournament-manager";
import { createTournamentManager } from "../../apps/game-server/src/tournaments/tournament-manager";
import { deriveSeed } from "../support/random";
import { createFakeClock, type FakeClock } from "../support/fake-clock";
import {
  createInMemoryRoomRepository,
  type InMemoryRoomRepository,
} from "./in-memory-room-repository";

/** 测试专用 HMAC 密钥（≥32 字符即可通过 AppConfig 校验；不是生产密钥）。 */
export const WS_TEST_TOKEN_SECRET = "tex28-ws-layer-test-token-secret-0000000001";

export interface PlayerSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly playerToken: string;
  readonly roomSnapshot: RoomSnapshot;
}

export interface ServerHarness {
  readonly httpBaseUrl: string;
  readonly wsUrl: string;
  readonly clock: FakeClock;
  readonly roomManager: RoomManager;
  readonly tournamentManager: TournamentManager;
  readonly roomRepository: InMemoryRoomRepository;
  /** 从场景 seed 派生下一个比赛 seed（同一 harness 内多局可复现）。 */
  nextTournamentSeed(): number;
  createRoom(displayName: string, config?: Partial<TournamentConfig>): Promise<PlayerSession>;
  joinRoom(inviteCode: string, displayName: string): Promise<PlayerSession>;
  close(): Promise<void>;
}

export function defaultTestConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    maxPlayers: 2,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    blindMode: "fixed",
    blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
    actionTime: 30,
    timeBank: 60,
    ...overrides,
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function startServerHarness(options: { seed: number }): Promise<ServerHarness> {
  const clock = createFakeClock({ now: 1_750_000_000_000 });
  const ids = createNodeIdSource();
  const connectionEpochs = createConnectionEpochRegistry();
  const tournamentEvents = createTournamentEventBus();
  const roomRepository = createInMemoryRoomRepository();
  const baseStarter = createPersistenceTournamentStarter(roomRepository);

  // 与 main.ts 相同的 TDZ 闭包模式：roomManager 在 tournamentManager 之后赋值。
  // eslint-disable-next-line prefer-const
  let roomManager: RoomManager;
  const tournamentManager = createTournamentManager({
    clock: () => clock.now(),
    ids,
    scheduler: clock,
    output: {
      emitEvents: tournamentEvents.emitEvents,
      emitClockUpdated: tournamentEvents.emitClockUpdated,
      // 内存 Fake：Commit Bundle 不落库；持久化结论由 Integration 层负责。
      enqueueCommitBundles: () => undefined,
      submitRoomCommand: (roomId, command) => {
        void roomManager.submitCommand(roomId, command).catch(() => undefined);
      },
    },
    executorDeps: {
      isConnectionCurrent: connectionEpochs.isCurrent,
      isBackpressurePaused: () => false,
    },
  });

  let tournamentCounter = 0;
  const registerRuntime = createRuntimeTournamentRegistrar({
    manager: tournamentManager,
    rngFactory: () =>
      new SeededRandomSource(deriveSeed(options.seed, `tournament-${tournamentCounter++}`)),
  });
  const persistence = createRoomPersistence({ roomRepository, startTournament: baseStarter.start });
  roomManager = createRoomManager({
    persistence,
    roomRepository,
    ids,
    tokenSecret: WS_TEST_TOKEN_SECRET,
    tokenKeyId: "ws-test",
    isConnectionCurrent: connectionEpochs.isCurrent,
    isPersistenceAvailable: () => true,
    onStartCommitted: registerRuntime.register,
  });

  const app = buildApp({
    config: {
      token: { secret: WS_TEST_TOKEN_SECRET, keyId: "ws-test" },
      corsAllowedOrigins: [],
    },
    roomManager,
    tournamentManager,
    tournamentEvents,
    connectionEpochs,
    now: () => clock.now(),
    lobbyGatewayClock: clock,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("expected a TCP listen address");
  const httpBaseUrl = `http://127.0.0.1:${address.port}`;

  async function createRoom(
    displayName: string,
    config: Partial<TournamentConfig> = {},
  ): Promise<PlayerSession> {
    const outcome = await postJson(httpBaseUrl, "/api/v1/rooms", {
      displayName,
      config: defaultTestConfig(config),
    });
    if (outcome.status !== 200)
      throw new Error(`createRoom failed: ${JSON.stringify(outcome.body)}`);
    return (outcome.body as { data: PlayerSession }).data;
  }

  async function joinRoom(inviteCode: string, displayName: string): Promise<PlayerSession> {
    const outcome = await postJson(httpBaseUrl, "/api/v1/rooms/join", { inviteCode, displayName });
    if (outcome.status !== 200) throw new Error(`joinRoom failed: ${JSON.stringify(outcome.body)}`);
    return (outcome.body as { data: PlayerSession }).data;
  }

  return {
    httpBaseUrl,
    wsUrl: `${httpBaseUrl}/api/v1/ws`,
    clock,
    roomManager,
    tournamentManager,
    roomRepository,
    nextTournamentSeed: () => deriveSeed(options.seed, `tournament-${tournamentCounter}`),
    createRoom,
    joinRoom,
    async close() {
      await app.close();
      clock.dispose();
    },
  };
}
