import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database, GameTransaction } from "../database";
import { gameSnapshots, handEvents, hands, tournaments, tournamentPlayers } from "../schema";
import { PersistenceError } from "./errors";

/**
 * 崩溃恢复读取/回退仓储（docs/03-data-model.md §4.3/§7.5；docs/04 §13）。
 *
 * 只提供恢复编排所需的最小读取与回退能力：
 * - `listActiveTournaments`：定位活跃（IN_GAME）比赛及其锁定参赛者；
 * - `listSnapshots`：按 sequence 降序返回候选手末 Snapshot（恢复根）；
 * - `hasCommittedEventsThrough`：验证已提交事件 1..upToSequence 连续无缺口；
 * - `listWithdrawnForfeited`：保留区域内的 WITHDRAWN forfeitedChips 汇总（回退重置用）；
 * - `rollbackToSnapshot`：**向前退回**——删除某 sequence 之后的手/事件/快照、复位
 *   Tournament 水位，并按快照引擎参与者重置 `tournament_players`（§4.3/§7.5「回退到
 *   上一个可验证 Snapshot；不得猜测或拼接部分状态」）。
 *
 * 读取路径属 TEX-22；Hand History 投影读取属后续任务，不在此处。
 */

export interface ActiveTournamentPlayer {
  readonly id: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly kind: "HUMAN" | "BOT";
  readonly startingStack: bigint;
}

export interface ActiveTournamentRecord {
  readonly tournamentId: string;
  readonly roomId: string;
  /** TournamentConfig（已通过服务端 Schema Validation 的持久化快照，§5.3）。 */
  readonly configJson: unknown;
  readonly lastCommittedSequence: bigint;
  readonly players: readonly ActiveTournamentPlayer[];
}

export interface CommittedSnapshotRecord {
  readonly tournamentId: string;
  readonly handId: string;
  readonly sequence: bigint;
  /** 解析后的内部 GameState（恢复重建输入）。 */
  readonly state: unknown;
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly stateChecksum: Buffer;
  readonly commitChecksum: Buffer;
  readonly createdAt: Date;
}

/** 回退时用于重置 tournament_players 的参与者状态（来自快照引擎 participants）。 */
export interface SnapshotParticipantState {
  readonly seatIndex: number;
  readonly status: "ACTIVE" | "EXIT_PENDING" | "WITHDRAWN" | "ELIMINATED";
  readonly chips: number;
  /** 终局名次（finish.placementRange.from）；无名次为 null。 */
  readonly rank: number | null;
}

export interface RecoveryRepository {
  listActiveTournaments(): Promise<ActiveTournamentRecord[]>;
  listSnapshots(tournamentId: string): Promise<CommittedSnapshotRecord[]>;
  /** 该 Tournament 已提交事件 1..upToSequence 严格连续（count == upToSequence）。 */
  hasCommittedEventsThrough(tournamentId: string, upToSequence: bigint): Promise<boolean>;
  /** 保留区域（1..toSequence）内 WITHDRAWN 的 forfeitedChips 汇总（按 seatIndex）。 */
  listWithdrawnForfeited(tournamentId: string, toSequence: bigint): Promise<Map<number, bigint>>;
  /**
   * 向前退回：单事务删除 sequence > toSequence 的事件/手/快照、复位
   * `last_committed_sequence`，并按快照参与者重置 `tournament_players`
   * （pokerStatus/finalStack/rank/forfeitedChips；eliminatedHandId 无法从快照
   * 精确还原，置 NULL）。任何一步失败整体回滚，不留半回退。
   */
  rollbackToSnapshot(
    tournamentId: string,
    toSequence: bigint,
    participants: readonly SnapshotParticipantState[],
  ): Promise<void>;
}

export function createRecoveryRepository(database: Database): RecoveryRepository {
  async function listActiveTournaments(): Promise<ActiveTournamentRecord[]> {
    const rows = await database.db
      .select({
        tournamentId: tournaments.id,
        roomId: tournaments.roomId,
        configJson: tournaments.configJson,
        lastCommittedSequence: tournaments.lastCommittedSequence,
      })
      .from(tournaments)
      .where(eq(tournaments.status, "IN_GAME"));
    const records: ActiveTournamentRecord[] = [];
    for (const row of rows) {
      const players = await database.db
        .select({
          id: tournamentPlayers.id,
          playerId: tournamentPlayers.playerId,
          displayName: tournamentPlayers.displayName,
          seatIndex: tournamentPlayers.seatIndex,
          kind: tournamentPlayers.kind,
          startingStack: tournamentPlayers.startingStack,
        })
        .from(tournamentPlayers)
        .where(eq(tournamentPlayers.tournamentId, row.tournamentId));
      records.push({
        tournamentId: row.tournamentId,
        roomId: row.roomId,
        configJson: row.configJson,
        lastCommittedSequence: row.lastCommittedSequence,
        players: players.map((p) => ({
          id: p.id,
          playerId: p.playerId,
          displayName: p.displayName,
          seatIndex: p.seatIndex,
          kind: p.kind,
          startingStack: p.startingStack,
        })),
      });
    }
    return records;
  }

  async function listSnapshots(tournamentId: string): Promise<CommittedSnapshotRecord[]> {
    const rows = await database.db
      .select()
      .from(gameSnapshots)
      .where(eq(gameSnapshots.tournamentId, tournamentId))
      .orderBy(desc(gameSnapshots.sequence));
    return rows.map((row) => ({
      tournamentId: row.tournamentId,
      handId: row.handId,
      sequence: row.sequence,
      state: row.state,
      schemaVersion: row.schemaVersion,
      engineVersion: row.engineVersion,
      stateChecksum: row.stateChecksum,
      commitChecksum: row.commitChecksum,
      createdAt: row.createdAt,
    }));
  }

  async function hasCommittedEventsThrough(
    tournamentId: string,
    upToSequence: bigint,
  ): Promise<boolean> {
    const [row] = await database.db
      .select({ total: count() })
      .from(handEvents)
      .where(
        and(
          eq(handEvents.tournamentId, tournamentId),
          gte(handEvents.sequence, 1n),
          lte(handEvents.sequence, upToSequence),
        ),
      );
    return row !== undefined && BigInt(row.total) === upToSequence;
  }

  async function listWithdrawnForfeited(
    tournamentId: string,
    toSequence: bigint,
  ): Promise<Map<number, bigint>> {
    return queryWithdrawnForfeited(database.db, tournamentId, toSequence);
  }

  /** 查询保留区域内 PLAYER_WITHDRAWN 的 forfeitedChips（可传事务连接，读取在回退事务快照内）。 */
  async function queryWithdrawnForfeited(
    q: Pick<GameTransaction, "select">,
    tournamentId: string,
    toSequence: bigint,
  ): Promise<Map<number, bigint>> {
    const rows = await q
      .select({ payload: handEvents.payload })
      .from(handEvents)
      .where(
        and(
          eq(handEvents.tournamentId, tournamentId),
          eq(handEvents.type, "PLAYER_WITHDRAWN"),
          lte(handEvents.sequence, toSequence),
        ),
      );
    const result = new Map<number, bigint>();
    for (const row of rows) {
      const payload = row.payload as { seatIndex?: number; forfeitedChips?: number };
      if (typeof payload.seatIndex === "number" && typeof payload.forfeitedChips === "number") {
        result.set(payload.seatIndex, BigInt(payload.forfeitedChips));
      }
    }
    return result;
  }

  async function rollbackToSnapshot(
    tournamentId: string,
    toSequence: bigint,
    participants: readonly SnapshotParticipantState[],
  ): Promise<void> {
    await database.withTransaction(async (tx) => {
      // 先取要删除的手 id（删除事件后再按事件查询将为空）。
      const doomedHands = await tx
        .selectDistinct({ handId: handEvents.handId })
        .from(handEvents)
        .where(
          and(eq(handEvents.tournamentId, tournamentId), gte(handEvents.sequence, toSequence + 1n)),
        );
      const handIds = doomedHands.map((r) => r.handId);

      // 按快照引擎参与者重置 tournament_players（pokerStatus/finalStack/rank/forfeitedChips；
      // eliminatedHandId 清空）——**必须先于 DELETE hands**：`tournament_players_eliminated_hand_fk`
      // 为 ON DELETE RESTRICT（0000_init.sql），回退区域内被淘汰玩家的行仍指向待删手，
      // 若先删手会立即违反外键并整体回滚（P1-1）。
      const forfeitedBySeat = await queryWithdrawnForfeited(tx, tournamentId, toSequence);
      for (const participant of participants) {
        const withdrawnForfeited = forfeitedBySeat.get(participant.seatIndex) ?? 0n;
        const updated = await tx
          .update(tournamentPlayers)
          .set({
            // EXIT_PENDING 是运行期过渡态、手末边界不出现；防御性映射为 ACTIVE。
            pokerStatus: participant.status === "EXIT_PENDING" ? "ACTIVE" : participant.status,
            // final_stack 仅终局/撤回有意义：ACTIVE 必须为 NULL，避免把在场筹码误记为
            // 终结结果（docs/03 §5.4「未终结前可为 NULL」）。
            finalStack:
              participant.status === "ACTIVE" || participant.status === "EXIT_PENDING"
                ? null
                : BigInt(participant.chips),
            forfeitedChips: withdrawnForfeited,
            rank: participant.rank,
            eliminatedHandId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tournamentPlayers.tournamentId, tournamentId),
              eq(tournamentPlayers.seatIndex, participant.seatIndex),
            ),
          );
        if (updated.rowCount !== 1) {
          throw new PersistenceError(
            `recovery rollback: tournament_players row not found for seat ${participant.seatIndex} in ${tournamentId}`,
          );
        }
      }
      // 防御性兜底：快照参与者之外的任何行若仍引用待删手，一并清空引用（防孤立 FK）。
      if (handIds.length > 0) {
        await tx
          .update(tournamentPlayers)
          .set({ eliminatedHandId: null, updatedAt: new Date() })
          .where(
            and(
              eq(tournamentPlayers.tournamentId, tournamentId),
              inArray(tournamentPlayers.eliminatedHandId, handIds),
            ),
          );
      }

      await tx
        .delete(gameSnapshots)
        .where(
          and(
            eq(gameSnapshots.tournamentId, tournamentId),
            gte(gameSnapshots.sequence, toSequence + 1n),
          ),
        );
      await tx
        .delete(handEvents)
        .where(
          and(eq(handEvents.tournamentId, tournamentId), gte(handEvents.sequence, toSequence + 1n)),
        );
      if (handIds.length > 0) {
        await tx
          .delete(hands)
          .where(and(eq(hands.tournamentId, tournamentId), inArray(hands.id, handIds)));
      }

      await tx
        .update(tournaments)
        .set({ lastCommittedSequence: toSequence })
        .where(eq(tournaments.id, tournamentId));
    });
  }

  return {
    listActiveTournaments,
    listSnapshots,
    hasCommittedEventsThrough,
    listWithdrawnForfeited,
    rollbackToSnapshot,
  };
}
