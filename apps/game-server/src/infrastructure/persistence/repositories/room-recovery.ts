import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../database";
import { roomPlayers, rooms, tournamentPlayers, tournaments } from "../schema";
import type { ActiveTournamentPlayer } from "./recovery";
import { PersistenceError } from "./errors";

export const ROOM_REVISION_BLOCK_SIZE = 4_294_967_296;
export const INITIAL_ROOM_REVISION_CEILING = ROOM_REVISION_BLOCK_SIZE - 1;

export interface RoomRevisionReservation {
  readonly initial: number;
  readonly ceiling: number;
}

/** 恢复所需的 ACTIVE Room 身份；凭证摘要始终为服务端私有数据。 */
export interface RoomRecoveryMember {
  readonly playerId: string;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly kind: "HUMAN" | "BOT";
  readonly tokenDigest: Buffer | null;
  readonly tokenKeyId: string | null;
  readonly joinedAt: Date;
}

/** 最新一场或尚标记 IN_GAME 的比赛；不读取手牌、事件或私有快照。 */
export interface RoomRecoveryTournament {
  readonly tournamentId: string;
  readonly tournamentNo: number;
  readonly status: "IN_GAME" | "FINISHED" | "ABANDONED_NO_HUMAN";
  readonly configJson: unknown;
  readonly lastCommittedSequence: bigint;
  readonly players: readonly ActiveTournamentPlayer[];
}

export interface RoomRecoveryRecord {
  readonly roomId: string;
  readonly mode: "MULTIPLAYER" | "SINGLE_PLAYER";
  readonly inviteCode: string | null;
  readonly status: "CREATED" | "LOBBY" | "IN_GAME" | "FINISHED";
  /** 由恢复编排逐房校验；坏配置不能阻止其他房间的原始事实读取。 */
  readonly configJson: unknown;
  readonly hostPlayerId: string | null;
  /** 全部历史的 MAX(tournament_no)，不是记录数，也不只统计运行中比赛。 */
  readonly tournamentCount: number;
  readonly members: readonly RoomRecoveryMember[];
  /** 仅最新一场及所有 IN_GAME，按 tournamentNo 降序；支持识别落库延迟的旧场。 */
  readonly tournaments: readonly RoomRecoveryTournament[];
}

export interface RoomRecoveryRepository {
  /** 同一只读、可重复读事务中的 Room / ACTIVE 身份 / Tournament / locked seats。 */
  listRecoverableRooms(): Promise<RoomRecoveryRecord[]>;
  /** 原子预留下一个 revision 号段；CLOSED、缺失或安全整数号段耗尽时拒绝。 */
  reserveRoomRevision(roomId: string): Promise<RoomRevisionReservation>;
}

/**
 * TEX-51 Room 启动恢复读取（docs/03 §4.3/§5/§7.5，docs/04 §13）。
 *
 * 四张控制面表必须来自同一 PostgreSQL 快照，不能在 READ COMMITTED 的多个
 * 语句间拼出「旧 Room 状态 + 新成员/新比赛」。恢复编排负责 Schema 校验、
 * Host/比赛一致性判定及逐房隔离；本仓储不推断未持久化的 seat/ready/连接态，
 * 不补发原 token，不加载 LEFT 摘要；读取路径不改写控制面或检查点。
 * 独立的 reserveRoomRevision 在校验后为启动原子预留号段（ADR-0003）。
 */
export function createRoomRecoveryRepository(database: Database): RoomRecoveryRepository {
  return {
    async reserveRoomRevision(roomId) {
      return database.withTransaction(async (tx) => {
        const blockSize = BigInt(ROOM_REVISION_BLOCK_SIZE);
        const [reserved] = await tx
          .update(rooms)
          .set({ roomRevisionCeiling: sql`${rooms.roomRevisionCeiling} + ${blockSize}` })
          .where(
            and(
              eq(rooms.id, roomId),
              ne(rooms.status, "CLOSED"),
              lte(rooms.roomRevisionCeiling, BigInt(Number.MAX_SAFE_INTEGER) - blockSize),
            ),
          )
          .returning({ ceiling: rooms.roomRevisionCeiling });
        if (reserved === undefined) {
          throw new PersistenceError("ROOM_REVISION_RESERVATION_FAILED");
        }
        return {
          initial: Number(reserved.ceiling - blockSize + 1n),
          ceiling: Number(reserved.ceiling),
        };
      });
    },

    async listRecoverableRooms() {
      return database.withTransaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);

        const roomRows = await tx
          .select({
            roomId: rooms.id,
            mode: rooms.mode,
            inviteCode: rooms.inviteCode,
            status: rooms.status,
            configJson: rooms.configJson,
            hostPlayerId: rooms.hostPlayerId,
          })
          .from(rooms)
          .where(ne(rooms.status, "CLOSED"))
          .orderBy(asc(rooms.createdAt), asc(rooms.id));
        if (roomRows.length === 0) return [];
        const roomIds = roomRows.map((room) => room.roomId);

        const memberRows = await tx
          .select({
            roomId: roomPlayers.roomId,
            playerId: roomPlayers.id,
            displayName: roomPlayers.displayName,
            displayNameKey: roomPlayers.displayNameKey,
            kind: roomPlayers.kind,
            tokenDigest: roomPlayers.tokenDigest,
            tokenKeyId: roomPlayers.tokenKeyId,
            joinedAt: roomPlayers.joinedAt,
          })
          .from(roomPlayers)
          .where(and(inArray(roomPlayers.roomId, roomIds), eq(roomPlayers.status, "ACTIVE")))
          .orderBy(asc(roomPlayers.joinedAt), asc(roomPlayers.id));

        const tournamentRows = await tx
          .select({
            roomId: tournaments.roomId,
            tournamentId: tournaments.id,
            tournamentNo: tournaments.tournamentNo,
            status: tournaments.status,
            configJson: tournaments.configJson,
            lastCommittedSequence: tournaments.lastCommittedSequence,
          })
          .from(tournaments)
          .where(inArray(tournaments.roomId, roomIds))
          .orderBy(desc(tournaments.tournamentNo), asc(tournaments.id));

        const maxTournamentNo = new Map<string, number>();
        const selectedTournaments = tournamentRows.filter((tournament) => {
          // 查询已按编号降序：首次遇到 Room 即其最新一场；历史数量不影响编号。
          const isLatest = !maxTournamentNo.has(tournament.roomId);
          if (isLatest) maxTournamentNo.set(tournament.roomId, tournament.tournamentNo);
          return isLatest || tournament.status === "IN_GAME";
        });

        const playerRows =
          selectedTournaments.length === 0
            ? []
            : await tx
                .select({
                  tournamentId: tournamentPlayers.tournamentId,
                  id: tournamentPlayers.id,
                  playerId: tournamentPlayers.playerId,
                  displayName: tournamentPlayers.displayName,
                  seatIndex: tournamentPlayers.seatIndex,
                  kind: tournamentPlayers.kind,
                  startingStack: tournamentPlayers.startingStack,
                })
                .from(tournamentPlayers)
                .where(
                  inArray(
                    tournamentPlayers.tournamentId,
                    selectedTournaments.map((t) => t.tournamentId),
                  ),
                )
                .orderBy(asc(tournamentPlayers.seatIndex));

        const membersByRoom = new Map<string, RoomRecoveryMember[]>();
        for (const { roomId, ...member } of memberRows) {
          const members = membersByRoom.get(roomId) ?? [];
          members.push(member);
          membersByRoom.set(roomId, members);
        }
        const playersByTournament = new Map<string, ActiveTournamentPlayer[]>();
        for (const { tournamentId, ...player } of playerRows) {
          const players = playersByTournament.get(tournamentId) ?? [];
          players.push(player);
          playersByTournament.set(tournamentId, players);
        }
        const tournamentsByRoom = new Map<string, RoomRecoveryTournament[]>();
        for (const { roomId, ...tournament } of selectedTournaments) {
          const records = tournamentsByRoom.get(roomId) ?? [];
          records.push({
            ...tournament,
            players: playersByTournament.get(tournament.tournamentId) ?? [],
          });
          tournamentsByRoom.set(roomId, records);
        }

        const records: RoomRecoveryRecord[] = [];
        for (const room of roomRows) {
          if (room.status === "CLOSED") continue;
          records.push({
            ...room,
            status: room.status,
            tournamentCount: maxTournamentNo.get(room.roomId) ?? 0,
            members: membersByRoom.get(room.roomId) ?? [],
            tournaments: tournamentsByRoom.get(room.roomId) ?? [],
          });
        }
        return records;
      });
    },
  };
}
