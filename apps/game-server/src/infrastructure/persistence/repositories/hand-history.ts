import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../database";
import { handEvents, hands, roomPlayers, tournamentPlayers, tournaments } from "../schema";

/**
 * Hand History 投影读取仓储（docs/03-data-model.md §5.5/§5.6/§6；docs/02 §4.2；TEX-36）。
 *
 * 只读：`hands` 行只在手末 Commit Bundle 单事务内与 `hand_events`/`game_snapshots`
 * 一同插入（§7.3），因此本表中的行即「已经手末原子提交的 Hand」——无需额外
 * Snapshot 存在性联查。
 *
 * 隐私红线（docs/03 §6/§9）：`hand_events.payload` 与 `hands.community_cards`/
 * `hands.summary` 是服务器私有原始数据（含 Burn 牌面、未公开底牌）；本仓储只负责
 * 读取，所有对外输出必须经 `http/routes/hand-history.ts` 的接收者视角投影，
 * 原始行永不直接投递客户端。
 *
 * 鉴权读取（`findTournamentRoom`/`listRoomMemberCredentials`/`listParticipants`）
 * 支撑 `Authorization: Bearer <playerToken>` → playerId 的数据库侧解析：内存
 * RoomManager 只覆盖进程存活期，归档历史（房间关闭/进程重启后）必须经
 * `room_players.token_digest`（HMAC）解析。
 */

/** `hands` 行（服务器私有；`communityCards`/`summary` 为 Engine 原始 JSON）。 */
export interface HandHistoryHandRecord {
  readonly id: string;
  readonly handNumber: number;
  readonly blindLevelIndex: number;
  readonly smallBlind: bigint;
  readonly bigBlind: bigint;
  readonly communityCards: unknown;
  readonly summary: unknown;
  readonly endReason: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

/** Room 成员凭证（HUMAN 持 HMAC 摘要；BOT 永无凭证，docs/03 §5.2）。 */
export interface RoomMemberCredentialRecord {
  readonly playerId: string;
  readonly kind: "HUMAN" | "BOT";
  readonly tokenDigest: Buffer | null;
  readonly tokenKeyId: string | null;
}

/** Tournament 锁定参赛者（开局冻结的 seatIndex → playerId 映射来源）。 */
export interface TournamentParticipantRecord {
  readonly playerId: string;
  readonly seatIndex: number;
}

/** `hand_events` 行（Engine 原始事件，含隐藏信息；对外必须投影）。 */
export interface HandHistoryEventRecord {
  readonly sequence: bigint;
  readonly handSequence: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface HandHistoryReadRepository {
  /** Tournament 存在时返回其所属 Room；不存在返回 null（→ 404）。 */
  findTournamentRoom(tournamentId: string): Promise<{ readonly roomId: string } | null>;
  /** Room 全体成员凭证（不筛 status：归档房间全员 LEFT 后仍可凭 token 查历史）。 */
  listRoomMemberCredentials(roomId: string): Promise<readonly RoomMemberCredentialRecord[]>;
  /** Tournament 全部锁定参赛者（含已淘汰/撤回）。 */
  listParticipants(tournamentId: string): Promise<readonly TournamentParticipantRecord[]>;
  /** 按 `handNumber` 倒序分页；`beforeHandNumber` 为排他下界（null = 从最新开始）。 */
  listHands(
    tournamentId: string,
    beforeHandNumber: number | null,
    limit: number,
  ): Promise<readonly HandHistoryHandRecord[]>;
  /** 手不存在或不属于该 Tournament 时返回 null（→ 404）。 */
  findHand(tournamentId: string, handId: string): Promise<HandHistoryHandRecord | null>;
  /** 该手全部已提交事件，按 Tournament 作用域 `sequence` 升序。 */
  listHandEvents(tournamentId: string, handId: string): Promise<readonly HandHistoryEventRecord[]>;
}

export function createHandHistoryRepository(database: Database): HandHistoryReadRepository {
  async function findTournamentRoom(tournamentId: string): Promise<{ roomId: string } | null> {
    const [row] = await database.db
      .select({ roomId: tournaments.roomId })
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    return row ?? null;
  }

  async function listRoomMemberCredentials(
    roomId: string,
  ): Promise<readonly RoomMemberCredentialRecord[]> {
    const rows = await database.db
      .select({
        playerId: roomPlayers.id,
        kind: roomPlayers.kind,
        tokenDigest: roomPlayers.tokenDigest,
        tokenKeyId: roomPlayers.tokenKeyId,
      })
      .from(roomPlayers)
      .where(eq(roomPlayers.roomId, roomId));
    return rows;
  }

  async function listParticipants(
    tournamentId: string,
  ): Promise<readonly TournamentParticipantRecord[]> {
    const rows = await database.db
      .select({
        playerId: tournamentPlayers.playerId,
        seatIndex: tournamentPlayers.seatIndex,
      })
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.tournamentId, tournamentId));
    return rows;
  }

  async function listHands(
    tournamentId: string,
    beforeHandNumber: number | null,
    limit: number,
  ): Promise<readonly HandHistoryHandRecord[]> {
    const condition =
      beforeHandNumber === null
        ? eq(hands.tournamentId, tournamentId)
        : and(eq(hands.tournamentId, tournamentId), lt(hands.handNumber, beforeHandNumber));
    const rows = await database.db
      .select({
        id: hands.id,
        handNumber: hands.handNumber,
        blindLevelIndex: hands.blindLevelIndex,
        smallBlind: hands.smallBlind,
        bigBlind: hands.bigBlind,
        communityCards: hands.communityCards,
        summary: hands.summary,
        endReason: hands.endReason,
        startedAt: hands.startedAt,
        endedAt: hands.endedAt,
      })
      .from(hands)
      .where(condition)
      .orderBy(desc(hands.handNumber))
      .limit(limit);
    return rows;
  }

  async function findHand(tournamentId: string, handId: string): Promise<HandHistoryHandRecord | null> {
    const [row] = await database.db
      .select({
        id: hands.id,
        handNumber: hands.handNumber,
        blindLevelIndex: hands.blindLevelIndex,
        smallBlind: hands.smallBlind,
        bigBlind: hands.bigBlind,
        communityCards: hands.communityCards,
        summary: hands.summary,
        endReason: hands.endReason,
        startedAt: hands.startedAt,
        endedAt: hands.endedAt,
      })
      .from(hands)
      .where(and(eq(hands.tournamentId, tournamentId), eq(hands.id, handId)));
    return row ?? null;
  }

  async function listHandEvents(
    tournamentId: string,
    handId: string,
  ): Promise<readonly HandHistoryEventRecord[]> {
    const rows = await database.db
      .select({
        sequence: handEvents.sequence,
        handSequence: handEvents.handSequence,
        type: handEvents.type,
        payload: handEvents.payload,
      })
      .from(handEvents)
      .where(and(eq(handEvents.tournamentId, tournamentId), eq(handEvents.handId, handId)))
      .orderBy(asc(handEvents.sequence));
    return rows;
  }

  return {
    findTournamentRoom,
    listRoomMemberCredentials,
    listParticipants,
    listHands,
    findHand,
    listHandEvents,
  };
}
