/** TEX-52：实际 Runtime 卸载不删除已提交历史，也不延长 Room/成员读取授权。 */
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SeededRandomSource } from "@texas-holdem/poker-engine";
import {
  HandHistoryDetailResponseSchema,
  HandHistoryListResponseSchema,
  type CommandResultPayload,
  type SubmitAction,
  type TournamentConfig,
} from "@texas-holdem/protocol";
import { createFakeClock } from "../../../../tests/support/fake-clock";
import { describeTestDatabase } from "../../../../tests/support/test-db";
import { registerHandHistoryRoutes } from "../../src/http/routes/hand-history";
import {
  createHandCommitRepository,
  createHandHistoryRepository,
  createRoomRepository,
} from "../../src/infrastructure/persistence/repositories";
import { roomPlayers, rooms as roomTable } from "../../src/infrastructure/persistence/schema";
import { createPersistenceWriter } from "../../src/persistence/persistence-writer";
import { createRoomManager, type RoomManager } from "../../src/rooms/room-manager";
import { createRoomPersistence } from "../../src/rooms/room-persistence";
import {
  createPersistenceTournamentStarter,
  createRuntimeTournamentRegistrar,
} from "../../src/rooms/tournament-starter";
import {
  createTournamentManager,
  TOURNAMENT_RETENTION_MS,
} from "../../src/tournaments/tournament-manager";
import { setupIntegrationDatabase, type IntegrationDatabase } from "./helpers";

const TOKEN_SECRET = "tex52-terminal-history-test-secret-00000001";
const CONFIG: TournamentConfig = {
  maxPlayers: 2,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindMode: "fixed",
  blindStructure: [{ smallBlind: 5, bigBlind: 10 }],
  actionTime: 30,
  timeBank: 0,
};

describeTestDatabase(
  "TEX-52 terminal runtime unload preserves authorized PostgreSQL history",
  (context) => {
    let testDb: IntegrationDatabase | undefined;
    beforeAll(async () => {
      testDb = await setupIntegrationDatabase(context);
    });
    afterAll(async () => {
      await testDb?.end();
    });

    it("serves both original players after retention unload, hides private cards and denies LEFT/CLOSED credentials", async () => {
      const clock = createFakeClock({ now: 1_760_000_000_000 });
      const ids = { uuid: randomUUID, now: () => clock.now(), randomBytes };
      const roomRepository = createRoomRepository(testDb!.database);
      const writer = createPersistenceWriter({
        commit: createHandCommitRepository(testDb!.database),
        scheduler: clock,
        clock: () => clock.now(),
        random: () => 0.5,
      });
      const pendingRoomCommands = new Set<Promise<unknown>>();
      const roomErrors: unknown[] = [];
      const handIds: string[] = [];
      let markUnloaded!: (tournamentId: string) => void;
      const unloaded = new Promise<string>((resolve) => {
        markUnloaded = resolve;
      });
      // eslint-disable-next-line prefer-const -- production composition uses the same Room/Tournament closure
      let rooms: RoomManager;
      const tournaments = createTournamentManager({
        clock: () => clock.now(),
        scheduler: clock,
        ids,
        executorDeps: {},
        output: {
          emitEvents: () => undefined,
          emitClockUpdated: () => undefined,
          enqueueCommitBundles: (bundles) => {
            handIds.push(...bundles.map((bundle) => bundle.hand.id));
            writer.enqueue(bundles);
          },
          submitRoomCommand: (roomId, command) => {
            const pending = rooms.submitCommand(roomId, command);
            pendingRoomCommands.add(pending);
            void pending.then(
              () => pendingRoomCommands.delete(pending),
              (error) => {
                pendingRoomCommands.delete(pending);
                roomErrors.push(error);
              },
            );
          },
        },
        onUnloaded: (tournamentId) => {
          writer.releaseTournament(tournamentId);
          markUnloaded(tournamentId);
        },
      });
      const starter = createPersistenceTournamentStarter(roomRepository);
      const registrar = createRuntimeTournamentRegistrar({
        manager: tournaments,
        rngFactory: () => new SeededRandomSource(52),
      });
      rooms = createRoomManager({
        roomRepository,
        persistence: createRoomPersistence({ roomRepository, startTournament: starter.start }),
        ids,
        tokenSecret: TOKEN_SECRET,
        tokenKeyId: "test-key",
        clock: () => clock.now(),
        scheduler: clock,
        onStartCommitted: registrar.register,
        onClosed: (roomId) => tournaments.disposeRoom(roomId),
      });
      const app = Fastify({ logger: false });
      registerHandHistoryRoutes(app, {
        repository: createHandHistoryRepository(testDb!.database),
        tokenSecretForKeyId: (keyId) => keyId === "test-key" ? TOKEN_SECRET : undefined,
        rateLimit: { max: 1000, timeWindow: "1 minute" },
        now: () => clock.now(),
        makeTraceId: randomUUID,
      });
      await app.ready();

      async function settleRoomCommands(): Promise<void> {
        while (pendingRoomCommands.size > 0) await Promise.all([...pendingRoomCommands]);
        expect(roomErrors).toEqual([]);
      }

      try {
        const host = await rooms.createRoom({
          displayName: "Host",
          displayNameKey: "host",
          config: CONFIG,
        });
        const guest = await rooms.joinRoom({
          inviteCode: host.roomSnapshot.inviteCode!,
          displayName: "Guest",
          displayNameKey: "guest",
        });
        for (const [seat, session] of [host, guest].entries()) {
          await rooms.submitCommand(session.roomId, {
            type: "CHANGE_SEAT",
            playerId: session.playerId,
            seat,
          });
          await rooms.submitCommand(session.roomId, {
            type: "SET_READY",
            playerId: session.playerId,
            ready: true,
          });
        }
        const tournamentId = randomUUID();
        await rooms.submitCommand(host.roomId, {
          type: "START_TOURNAMENT",
          actorPlayerId: host.playerId,
          tournamentId,
          expectedRevision: Number(rooms.getSnapshot(host.roomId)!.roomRevision),
        });
        await tournaments.setConnection(tournamentId, host.playerId, true);
        let ingressOrdinal = 0;
        async function action(value: SubmitAction): Promise<void> {
          const view = tournaments.getView(tournamentId)!;
          const seat = view.engineState.hand!.currentActor!;
          const result = (await tournaments.submit(tournamentId, {
            type: "SUBMIT_ACTION",
            playerId: view.seatToPlayer.get(seat)!,
            action: value,
            requestId: randomUUID(),
            actionId: randomUUID(),
            expectedSequence: String(view.lastWireSequence),
            receivedAt: clock.now(),
            ingressOrdinal: ++ingressOrdinal,
          })) as CommandResultPayload;
          expect(result.status).toBe("APPLIED");
        }
        // The first hand ends without revealing either player's cards.
        await action({ type: "FOLD" });
        expect(handIds).toHaveLength(1);
        const privateHandId = handIds[0]!;
        // Finish through real legal betting, including any split pots/short-stack continuations.
        for (
          let i = 0;
          i < 100 && tournaments.getView(tournamentId)!.status === "RUNNING";
          i += 1
        ) {
          const legal = tournaments.getView(tournamentId)!.currentLegalActions!;
          await action(
            legal.canAllIn
              ? { type: "ALL_IN" }
              : legal.canCall
                ? { type: "CALL" }
                : { type: "CHECK" },
          );
        }
        expect(tournaments.getView(tournamentId)?.status).toBe("FINISHED");
        await settleRoomCommands();
        await writer.flush();
        expect(writer.pendingCount()).toBe(0);
        expect(rooms.getSnapshot(host.roomId)?.status).toBe("FINISHED");
        const [persistedRoom] = await testDb!.database.db
          .select()
          .from(roomTable)
          .where(eq(roomTable.id, host.roomId));
        expect(persistedRoom!.status).toBe("FINISHED");
        const persistedMembers = await testDb!.database.db
          .select()
          .from(roomPlayers)
          .where(eq(roomPlayers.roomId, host.roomId));
        expect(persistedMembers.map((member) => member.status)).toEqual(["ACTIVE", "ACTIVE"]);

        clock.advance(TOURNAMENT_RETENTION_MS - 1);
        expect(tournaments.getView(tournamentId)).toBeDefined();
        clock.advance(1);
        expect(await unloaded).toBe(tournamentId);
        expect(tournaments.getView(tournamentId)).toBeUndefined();
        expect(tournaments.runtimeCounts().registered).toBe(0);
        expect(writer.queueCount()).toBe(0);
        expect(rooms.getSnapshot(host.roomId)?.status).toBe("FINISHED");

        const listUrl = `/api/v1/tournaments/${tournamentId}/hands`;
        const detailUrl = `${listUrl}/${privateHandId}`;
        for (const session of [host, guest]) {
          const authorization = `Bearer ${session.playerToken}`;
          const list = await app.inject({
            method: "GET",
            url: listUrl,
            headers: { authorization },
          });
          expect(list.statusCode).toBe(200);
          const items = HandHistoryListResponseSchema.parse(list.json()).data.items;
          expect(items.length).toBe(handIds.length);
          expect(items.some((item) => item.handId === privateHandId)).toBe(true);
          const detail = await app.inject({
            method: "GET",
            url: detailUrl,
            headers: { authorization },
          });
          expect(detail.statusCode).toBe(200);
          const events = HandHistoryDetailResponseSchema.parse(detail.json()).data.events.map(
            (message) => message.payload.event,
          );
          const deals = events.filter((event) => event.type === "DEAL_HOLE_CARD");
          expect(deals).toHaveLength(4);
          expect(events.some((event) => event.type === "PLAYER_REVEALED")).toBe(false);
          for (const event of deals) {
            expect(event.payload.card !== undefined).toBe(
              event.payload.playerId === session.playerId,
            );
          }
          expect(detail.body).not.toContain("tokenDigest");
          expect(detail.body).not.toContain("serverTimeBank");
          const finalHand = await app.inject({
            method: "GET",
            url: `${listUrl}/${handIds.at(-1)!}`,
            headers: { authorization },
          });
          expect(finalHand.statusCode).toBe(200);
          const finalEvents = HandHistoryDetailResponseSchema.parse(
            finalHand.json(),
          ).data.events.map((message) => message.payload.event);
          const burns = finalEvents.filter((event) => event.type === "BURN_CARD");
          expect(burns).toHaveLength(3);
          for (const burn of burns) expect(burn.payload).not.toHaveProperty("card");
        }

        // Runtime expiry must not extend a departed member's authorization.
        await rooms.submitCommand(host.roomId, {
          type: "LEAVE",
          playerId: guest.playerId,
          reason: "USER_LEFT",
          leftAt: clock.now(),
        });
        for (const url of [listUrl, detailUrl]) {
          const departed = await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${guest.playerToken}` },
          });
          expect(departed.statusCode).toBe(401);
          expect(departed.json().error.code).toBe("AUTH_FAILED");
          const remaining = await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${host.playerToken}` },
          });
          expect(remaining.statusCode).toBe(200);
        }
        await rooms.submitCommand(host.roomId, { type: "CLOSE_ROOM", reason: "TEST_COMPLETE" });
        expect(rooms.findRoom(host.roomId)).toBeUndefined();
        for (const session of [host, guest]) {
          for (const url of [listUrl, detailUrl]) {
            const closed = await app.inject({
              method: "GET",
              url,
              headers: { authorization: `Bearer ${session.playerToken}` },
            });
            expect(closed.statusCode).toBe(401);
            expect(closed.json().error.code).toBe("AUTH_FAILED");
          }
        }
      } finally {
        await settleRoomCommands();
        await app.close();
        await rooms.dispose();
        await tournaments.dispose();
        await writer.flush();
        writer.dispose();
        expect(clock.pendingTimers()).toBe(0);
        clock.dispose();
      }
    }, 15_000);
  },
);
