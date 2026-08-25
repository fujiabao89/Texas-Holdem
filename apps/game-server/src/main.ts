import { buildApp } from "./app";
import { parseAppConfig } from "./config";
import {
  createDatabase,
  parseDatabaseConfig,
} from "./infrastructure/persistence/database";
import { createRoomRepository } from "./infrastructure/persistence/repositories";
import { createNodeIdSource } from "./rooms/id-source";
import { createRoomManager, type RoomManager } from "./rooms/room-manager";
import { createRoomPersistence } from "./rooms/room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentStarter,
} from "./rooms/tournament-starter";
import { createMonotonicEpochClock, createNodeTimerScheduler } from "./scheduler/timer-scheduler";
import { createTournamentManager } from "./tournaments/tournament-manager";
import { createConnectionEpochRegistry } from "./realtime/connection-epochs";
import { createTournamentEventBus } from "./realtime/tournament-event-bus";
import { SecureRandomSource } from "@texas-holdem/poker-engine";

const config = parseAppConfig();
const database = createDatabase(parseDatabaseConfig());
const roomRepository = createRoomRepository(database);
const ids = createNodeIdSource();
const scheduler = createNodeTimerScheduler();
const tournamentClock = createMonotonicEpochClock(); // 单调时钟做超时裁决（04 §7.2）
const connectionEpochs = createConnectionEpochRegistry();
const tournamentEvents = createTournamentEventBus();
const baseStarter = createPersistenceTournamentStarter(roomRepository);

// RoomManager 在 Tournament 输出汇之后创建（submitRoomCommand 闭包运行期引用，无循环初始化）。
// eslint-disable-next-line prefer-const -- 闭包在赋值前引用，需 let 维持 TDZ 语义
let roomManager: RoomManager;
const tournamentManager = createTournamentManager({
  clock: tournamentClock,
  ids,
  scheduler,
  output: {
    // 事件/计时输出供 TEX-21 连接层订阅、Commit Bundle 供 TEX-22 Writer 处理；
    // P0 交付前为空实现，不投递到客户端。
    emitEvents: tournamentEvents.emitEvents,
    emitClockUpdated: tournamentEvents.emitClockUpdated,
    enqueueCommitBundles: () => {},
    submitRoomCommand: (roomId, command) => {
      void roomManager.submitCommand(roomId, command).catch((error: unknown) => {
        // Room 持久化瞬时失败不阻塞 Tournament；记录后由 TEX-22 Writer/重试兜底。
        console.error(`tournament→room 命令失败 room=${roomId}`, error);
      });
    },
  },
  executorDeps: { isConnectionCurrent: connectionEpochs.isCurrent },
});

const starter = createRuntimeTournamentStarter({
  persistence: baseStarter,
  manager: tournamentManager,
  clock: tournamentClock,
  ids,
  scheduler,
  rngFactory: () => new SecureRandomSource(),
});
const persistence = createRoomPersistence({ roomRepository, startTournament: starter.start });
roomManager = createRoomManager({
  persistence,
  roomRepository,
  ids,
  tokenSecret: config.token.secret,
  tokenKeyId: config.token.keyId,
  isConnectionCurrent: connectionEpochs.isCurrent,
});

const app = buildApp({
  config,
  roomManager,
  tournamentManager,
  tournamentEvents,
  connectionEpochs,
});

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }, (err, address) => {
  if (err) {
    console.error(`game-server failed to start on ${host}:${port}`, err);
    process.exit(1);
  }
  console.log(`game-server listening at ${address}`);
});

// 优雅关闭：SIGTERM/SIGINT 时先停 Fastify（停止新请求、等待 in-flight 收尾），再释放连接池。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}, shutting down`);
  try {
    await app.close();
    await database.end();
  } finally {
    process.exit(0);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
