import { buildApp } from "./app";
import { parseAppConfig } from "./config";
import {
  createDatabase,
  parseDatabaseConfig,
} from "./infrastructure/persistence/database";
import {
  createHandCommitRepository,
  createHandHistoryRepository,
  createRecoveryRepository,
  createRoomRepository,
} from "./infrastructure/persistence/repositories";
import { createNodeIdSource } from "./rooms/id-source";
import { createRoomManager, type RoomManager } from "./rooms/room-manager";
import { createRoomPersistence } from "./rooms/room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentRegistrar,
} from "./rooms/tournament-starter";
import { createMonotonicEpochClock, createNodeTimerScheduler } from "./scheduler/timer-scheduler";
import { createTournamentManager, type TournamentManager } from "./tournaments/tournament-manager";
import { createConnectionEpochRegistry } from "./realtime/connection-epochs";
import { createTournamentEventBus } from "./realtime/tournament-event-bus";
import { createBackpressureLatch } from "./persistence/backpressure";
import { createPersistenceWriter } from "./persistence/persistence-writer";
import { recoverActiveTournaments } from "./persistence/recovery";
import { createTestRngFactory } from "./test-rng-factory";

/**
 * TEX-28 测试种子注入：生产默认安全随机（SecureRandomSource）；仅当隔离测试入口
 * 显式设置 TEX_TEST_RNG_SEED 时切换为确定性洗牌（每个 Tournament 派生独立子流），
 * 使真实链路 E2E 失败可按 seed 100% 重放（docs/06 §6）。seed 上界与派生边界由
 * `test-rng-factory.ts` 统一校验（SeededRandomSource 仅接受 [0, 2^32)）。生产环境
 * 严禁设置该变量。
 */
const rngTestSeed = process.env.TEX_TEST_RNG_SEED;
// P3-4 运行守卫：生产（NODE_ENV=production）严禁设置 TEX_TEST_RNG_SEED——否则所有
// 锦标赛洗牌可预测（公平性风险，且 seed 序列跨进程/重启会归零）。真实链路 E2E 以
// 非 production 环境启动，不受影响；部署误配时直接拒绝启动而非静默接受。
if (rngTestSeed !== undefined && process.env.NODE_ENV === "production") {
  throw new Error(
    "TEX_TEST_RNG_SEED is forbidden when NODE_ENV=production: it would make every tournament shuffle predictable",
  );
}
const rngFactory = createTestRngFactory(rngTestSeed);

const config = parseAppConfig();
const database = createDatabase(parseDatabaseConfig());
const roomRepository = createRoomRepository(database);
const ids = createNodeIdSource();
const scheduler = createNodeTimerScheduler();
const tournamentClock = createMonotonicEpochClock(); // 单调时钟做超时裁决（04 §7.2）
const connectionEpochs = createConnectionEpochRegistry();
const tournamentEvents = createTournamentEventBus();
const baseStarter = createPersistenceTournamentStarter(roomRepository);

// 持久化降级门控：soft watermark 后停止创建新 Room；shutdown 时也置为拒绝（§12.2/§13.1）。
const persistenceDegraded = { accepting: true };
const isPersistenceAvailable = (): boolean => persistenceDegraded.accepting;

// 背压 latch：hard 命中后保持暂停直到回落到 ok（低于 soft）才恢复（§12.2）。
const backpressureLatch = createBackpressureLatch();

// TEX-22 Persistence Writer：唯一写者的异步编排（队列/退避/watermark/flush，docs/04 §12）。
const writer = createPersistenceWriter({
  commit: createHandCommitRepository(database),
  scheduler,
  clock: tournamentClock,
  onBackpressureChange: (level) => {
    backpressureLatch.onLevel(level);
    persistenceDegraded.accepting = level === "ok";
    if (level === "hard") {
      console.warn("persistence hard watermark: pausing active tournaments at hand boundary");
    }
    // soft/hard → 停止创建新 Room；hard → 当前手结束后停在手间边界；仅回落到 ok → 恢复。
    if (tournamentManager !== undefined) {
      void tournamentManager.pauseAll(backpressureLatch.hardPaused);
    }
  },
  onIntegrityError: (error, bundle) => {
    // 数据损坏：Writer 已隔离该 Tournament（不重试/不覆盖）；通知运行期停当前手后（§13）。
    console.error(
      `persistence integrity error; quarantining tournament=${bundle.tournamentId}`,
      error,
    );
    if (tournamentManager !== undefined) {
      void tournamentManager
        .submit(bundle.tournamentId, { type: "SHUTDOWN" })
        .catch(() => undefined);
    }
  },
});

// RoomManager 与 TournamentManager 在 Tournament 输出汇之后创建（submitRoomCommand 闭包运行期引用，无循环初始化）。
// eslint-disable-next-line prefer-const -- 闭包在赋值前引用，需 let 维持 TDZ 语义
let roomManager: RoomManager;
// eslint-disable-next-line prefer-const -- writer 的 onBackpressureChange/onIntegrityError 闭包引用，需 let。
let tournamentManager: TournamentManager;
tournamentManager = createTournamentManager({
  clock: tournamentClock,
  ids,
  scheduler,
  output: {
    // 事件/计时输出供 TEX-21 连接层订阅、Commit Bundle 交 TEX-22 Writer 处理。
    emitEvents: tournamentEvents.emitEvents,
    emitClockUpdated: tournamentEvents.emitClockUpdated,
    enqueueCommitBundles: (bundles) => writer.enqueue(bundles),
    submitRoomCommand: (roomId, command) => {
      void roomManager.submitCommand(roomId, command).catch((error: unknown) => {
        // Room 持久化瞬时失败不阻塞 Tournament；记录后由 TEX-22 Writer/重试兜底。
        console.error(`tournament→room 命令失败 room=${roomId}`, error);
      });
    },
  },
  executorDeps: {
    isConnectionCurrent: connectionEpochs.isCurrent,
    // 同步 hard 背压检查：手末 bundle 自身触达 hard 时也能在推进下一手前停下（§12.2）。
    isBackpressurePaused: () => backpressureLatch.hardPaused,
  },
});

// TEX-28 F-7：运行时注册与控制面落库解耦——Room 提交 IN_GAME 之后才注册
// Tournament 运行时（首手事件晚于快照提交，网关不丢开局事件）。
const registerRuntime = createRuntimeTournamentRegistrar({
  manager: tournamentManager,
  rngFactory,
});
const persistence = createRoomPersistence({ roomRepository, startTournament: baseStarter.start });
roomManager = createRoomManager({
  persistence,
  roomRepository,
  ids,
  tokenSecret: config.token.secret,
  tokenKeyId: config.token.keyId,
  isConnectionCurrent: connectionEpochs.isCurrent,
  isPersistenceAvailable,
  onStartCommitted: registerRuntime.register,
});

const app = buildApp({
  config,
  roomManager,
  tournamentManager,
  tournamentEvents,
  connectionEpochs,
  // Hand History 投影读取（TEX-36）：归档历史经 token 摘要数据库侧鉴权，
  // 不依赖内存 RoomManager（进程重启/房间关闭后仍可读）。
  handHistoryRepository: createHandHistoryRepository(database),
});

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const host = process.env.HOST ?? "0.0.0.0";

/** 启动屏障（docs/04 §13）：监听前恢复活跃比赛；失败则快速退出，不对外提供服务。 */
async function recoverOnStartup(): Promise<void> {
  const summary = await recoverActiveTournaments({
    recoveryRepo: createRecoveryRepository(database),
    manager: tournamentManager,
    clock: tournamentClock,
    ids,
    scheduler,
    rngFactory,
    onUnrecoverable: (tournamentId, reason) => {
      console.error(`unrecoverable tournament=${tournamentId} isolated: ${reason}`);
    },
  });
  if (summary.recovered.length > 0) {
    console.info(`recovered ${summary.recovered.length} tournament(s) from committed snapshots`);
  }
  if (summary.reinitialized.length > 0) {
    console.info(`reinitialized ${summary.reinitialized.length} tournament(s) (no committed hand)`);
  }
  if (summary.unrecovered.length > 0) {
    console.error(`${summary.unrecovered.length} tournament(s) have no verifiable recovery root`);
  }
}

async function start(): Promise<void> {
  try {
    await recoverOnStartup();
  } catch (error) {
    console.error("recovery failed; refusing to serve requests (startup barrier)", error);
    process.exit(1);
  }
  app.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(`game-server failed to start on ${host}:${port}`, err);
      process.exit(1);
    }
    console.log(`game-server listening at ${address}`);
  });
}
void start();

// 优雅关闭（docs/04 §13.1）：停当前手后 → Writer Flush（30s）→ 关闭 Fastify 与连接池。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}, shutting down`);
  try {
    persistenceDegraded.accepting = false; // 停止新 WS Upgrade/创建加入/启动 Tournament
    await tournamentManager.pauseAll(true); // 所有 Tournament 停当前手后
    await waitForHandDrain(90_000); // §13.1 step 3：当前手最多 90 秒
    await writer.flush(30_000); // §13.1 step 4：Writer 最多 Flush 30 秒
    // §13.1 step 4「记录未提交 Bundle 数量后退出」：flush 超时后剩余为未提交。
    const uncommitted = writer.pendingCount();
    if (uncommitted > 0) {
      console.error(`shutdown: ${uncommitted} commit bundle(s) not flushed; they are not recovery roots`);
    }
    await app.close();
    await database.end();
  } finally {
    process.exit(0);
  }
}

/** 等待所有活跃 Tournament 到达手间边界且 Writer 队列排空（最小正确路径）。 */
function waitForHandDrain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      const busy = tournamentManager
        .activeTournamentIds()
        .some((id) => tournamentManager.getView(id)?.engineState.handInProgress === true);
      if ((!busy && writer.pendingCount() === 0) || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
