import { buildApp } from "./app";
import { parseAppConfig } from "./config";
import {
  createDatabase,
  parseDatabaseConfig,
} from "./infrastructure/persistence/database";
import { createRoomRepository } from "./infrastructure/persistence/repositories";
import { createNodeIdSource } from "./rooms/id-source";
import { createRoomManager } from "./rooms/room-manager";
import { createRoomPersistence } from "./rooms/room-persistence";
import { createPersistenceTournamentStarter } from "./rooms/tournament-starter";

const config = parseAppConfig();
const database = createDatabase(parseDatabaseConfig());
const roomRepository = createRoomRepository(database);
const starter = createPersistenceTournamentStarter(roomRepository);
const persistence = createRoomPersistence({ roomRepository, startTournament: starter.start });
const manager = createRoomManager({
  persistence,
  roomRepository,
  ids: createNodeIdSource(),
  tokenSecret: config.token.secret,
  tokenKeyId: config.token.keyId,
});

const app = buildApp({ config, roomManager: manager });

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
